/**
 * MenuItem: something a guest can order, with its RECIPE (Bill of Materials) embedded.
 *
 * WHY RecipeIngredients ARE EMBEDDED (not a separate collection):
 *   - Always read together: firing an order line needs the whole recipe of that menu item.
 *     Embedding makes that one indexed read instead of a join per line.
 *   - Bounded size: a recipe has roughly 3-30 ingredients and never grows without limit,
 *     so the 16 MB limit is not a concern.
 *   - Atomic edits: changing a recipe is a single-document write, so there's no
 *     half-updated BOM.
 *   - Ownership: an ingredient line has no meaning outside its menu item.
 * The reverse question ("which dishes use Tomato?", needed when an item runs out or its
 * cost changes) is served by the multikey index on `recipe.inventoryItemId` below.
 *
 * A separate collection would be the better choice if recipes were versioned with full
 * history, shared across many menu items as sub-recipes, or edited independently by
 * different teams at scale.
 *
 * Deduction uses the recipe AS IT IS when the line is fired, and the order line stores a
 * snapshot of what it consumed (OrderItem.inventoryConsumed). Later recipe edits therefore
 * never change the history of past orders.
 */
const mongoose = require('mongoose');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');
const softDeletePlugin = require('./plugins/softDelete.plugin');
const { schemaOptions, money, percent, tenantRef } = require('./schemas/common');
const { DIETARY_TAGS, ALLERGENS, UNITS } = require('../config/enums');

const { Schema } = mongoose;

const recipeIngredientSchema = new Schema(
  {
    inventoryItemId: tenantRef('InventoryItem', 'inventoryItemId', { required: true }),
    // Quantity per ONE portion, in the inventory item's BASE unit (e.g. 150 g)
    quantity: { type: Number, required: true, min: [0.0001, 'quantity must be > 0'] },
    unit: { type: String, enum: UNITS }, // copied from the InventoryItem by a hook (display and validation)
    // Trim and cooking loss. 10 = deduct 10% more than the plated quantity.
    wastagePercent: percent(0),
    note: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false }
);

const menuItemSchema = new Schema(
  {
    categoryId: tenantRef('MenuCategory', 'categoryId', { required: true }),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000 },
    sku: { type: String, trim: true, uppercase: true, maxlength: 40 },
    imageUrl: { type: String, trim: true },

    price: money({ required: true }), // selling price, minor units
    taxRate: { type: Number, min: 0, max: 100, default: null }, // null = use the tenant default

    tags: { type: [{ type: String, trim: true, lowercase: true, maxlength: 30 }], default: [] },
    dietary: { type: [{ type: String, enum: DIETARY_TAGS }], default: [] },
    allergens: { type: [{ type: String, enum: ALLERGENS }], default: [] },
    preparationTimeMinutes: { type: Number, min: 0, max: 600 },
    kitchenStation: { type: String, trim: true, maxlength: 40 }, // routes the ticket: "grill", "bar"

    isAvailable: { type: Boolean, default: true }, // quick "86" toggle during service
    isActive: { type: Boolean, default: true }, // hidden from the menu entirely
    // false for items with no stock impact (e.g. "Corkage fee")
    trackInventory: { type: Boolean, default: true },
    recipe: {
      type: [recipeIngredientSchema],
      default: [],
      validate: [
        {
          validator: (arr) => arr.length <= 100,
          message: 'A recipe may have at most 100 ingredients',
        },
        {
          validator(arr) {
            const ids = arr.map((r) => String(r.inventoryItemId));
            return new Set(ids).size === ids.length;
          },
          message: 'Each inventory item may appear only once per recipe; combine the quantities',
        },
      ],
    },
    sortOrder: { type: Number, default: 0 },
  },
  schemaOptions()
);

menuItemSchema.plugin(tenantScopePlugin);
menuItemSchema.plugin(softDeletePlugin);

// ---- Indexes --------------------------------------------------------------------
menuItemSchema.index({ tenantId: 1, categoryId: 1, sortOrder: 1 });
menuItemSchema.index({ tenantId: 1, isActive: 1, isAvailable: 1 });
menuItemSchema.index(
  { tenantId: 1, sku: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, sku: { $type: 'string' } } }
);
// Reverse BOM lookup (multikey): "which dishes use this ingredient?"
menuItemSchema.index({ tenantId: 1, 'recipe.inventoryItemId': 1 });
// Menu search. A compound text index needs the tenantId equality prefix in every $text query.
menuItemSchema.index({ tenantId: 1, name: 'text', description: 'text', tags: 'text' });

// ---- Hooks ----------------------------------------------------------------------
// Copy the base unit from each InventoryItem onto the recipe line so the UI can show
// "150 g" without a lookup, and so a unit change on the item is visible as a mismatch.
menuItemSchema.pre('validate', async function snapshotRecipeUnits() {
  if (!this.isModified('recipe') || this.recipe.length === 0) return;
  const ids = this.recipe.map((r) => r.inventoryItemId);
  const query = mongoose
    .model('InventoryItem')
    .find({ _id: { $in: ids }, tenantId: this.tenantId }, 'unit')
    .lean();
  if (this.$session()) query.session(this.$session());
  const units = new Map((await query).map((i) => [String(i._id), i.unit]));
  for (const line of this.recipe) {
    const unit = units.get(String(line.inventoryItemId));
    if (unit) line.unit = unit; // a missing item is reported by the tenantRef validator
  }
});

// ---- Methods --------------------------------------------------------------------
/**
 * Theoretical food cost of one portion from current average costs, in minor units.
 * foodCostPercent = cost / price. Most restaurants target 25-35%.
 */
menuItemSchema.methods.computeFoodCost = async function computeFoodCost() {
  if (this.recipe.length === 0) return { cost: 0, foodCostPercent: 0, lines: [] };
  const items = await mongoose
    .model('InventoryItem')
    .find({ _id: { $in: this.recipe.map((r) => r.inventoryItemId) }, tenantId: this.tenantId }, 'name unit averageCost', {
      withDeleted: true,
    })
    .lean();
  const byId = new Map(items.map((i) => [String(i._id), i]));

  const lines = this.recipe.map((r) => {
    const item = byId.get(String(r.inventoryItemId));
    const grossQty = r.quantity * (1 + (r.wastagePercent || 0) / 100);
    const cost = grossQty * (item?.averageCost || 0);
    return { inventoryItemId: r.inventoryItemId, name: item?.name, quantity: grossQty, unit: item?.unit, cost: Math.round(cost) };
  });
  const cost = lines.reduce((sum, l) => sum + l.cost, 0);
  return {
    cost,
    foodCostPercent: this.price > 0 ? Math.round((cost / this.price) * 10_000) / 100 : 0,
    lines,
  };
};

module.exports = mongoose.model('MenuItem', menuItemSchema);
