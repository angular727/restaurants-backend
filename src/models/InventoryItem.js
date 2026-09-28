/**
 * InventoryItem: a raw ingredient or stocked good (beef patty, flour, cola can).
 *
 * STOCK LEVEL DESIGN
 * `currentStock` is a DENORMALIZED CACHE of SUM(StockMovement.quantity) for the item.
 * StockMovement is the source of truth: an append-only ledger. We keep the cached number
 * because summing the ledger on every POS screen or low-stock check would be too slow.
 *
 * Rule: currentStock may only change through services/inventory.service#applyMovement,
 * which does `$inc currentStock` AND inserts a StockMovement in the same transaction.
 * The hooks below reject any other write to currentStock, so a stray
 * `updateOne({ $set: { currentStock: 50 } })` can't make the cache disagree with the
 * ledger. `inventoryService.reconcileItem()` recomputes the sum to audit this.
 *
 * UNITS: `unit` is the BASE unit (g, ml, pcs) used by stock, recipes and movements.
 * Suppliers often sell in bigger units ("case of 40"), described by `purchaseUnit`. Its
 * `factor` converts purchase units to base units when goods are received.
 */
const mongoose = require('mongoose');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');
const softDeletePlugin = require('./plugins/softDelete.plugin');
const { schemaOptions, tenantRef } = require('./schemas/common');
const { UNITS } = require('../config/enums');
const { AppError } = require('../utils/errors');

const { Schema } = mongoose;

const inventoryItemSchema = new Schema(
  {
    categoryId: tenantRef('InventoryCategory', 'categoryId'),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    sku: { type: String, trim: true, uppercase: true, maxlength: 40 },
    barcode: { type: String, trim: true, maxlength: 64 },
    description: { type: String, trim: true, maxlength: 500 },

    unit: { type: String, enum: UNITS, required: true },
    purchaseUnit: {
      name: { type: String, trim: true, maxlength: 30 }, // e.g. "case", "sack"
      factor: { type: Number, min: [0.0001, 'factor must be > 0'], default: 1 }, // base units per purchase unit
    },

    // Denormalized ledger balance. Read-only outside inventory.service (see file header).
    currentStock: { type: Number, default: 0 },
    reorderLevel: { type: Number, min: 0, default: 0 }, // alert when stock falls to or below this
    reorderQuantity: { type: Number, min: 0, default: 0 }, // suggested PO quantity (base units)
    parLevel: { type: Number, min: 0, default: 0 }, // ideal stock after a delivery

    // Weighted-average cost per BASE unit, in minor currency units. May be fractional
    // (e.g. 1.2 cents per gram). Updated on every purchase receipt and used to value
    // stock and cost each sale (COGS).
    averageCost: { type: Number, min: 0, default: 0 },
    lastPurchaseCost: { type: Number, min: 0, default: 0 },

    preferredSupplierId: tenantRef('Supplier', 'preferredSupplierId'),
    storageLocation: { type: String, trim: true, maxlength: 60 }, // "Walk-in cooler", "Dry store A"
    isPerishable: { type: Boolean, default: false },
    shelfLifeDays: { type: Number, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  schemaOptions()
);

inventoryItemSchema.plugin(tenantScopePlugin);
inventoryItemSchema.plugin(softDeletePlugin);

// ---- Indexes (all tenant-prefixed) ------------------------------------------
inventoryItemSchema.index(
  { tenantId: 1, sku: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, sku: { $type: 'string' } } }
);
inventoryItemSchema.index({ tenantId: 1, categoryId: 1, name: 1 });
inventoryItemSchema.index({ tenantId: 1, isActive: 1, name: 1 });
inventoryItemSchema.index({ tenantId: 1, preferredSupplierId: 1 });
// `sparse` is useless on a compound index whose first key is always present, so use a partial filter.
inventoryItemSchema.index(
  { tenantId: 1, barcode: 1 },
  { partialFilterExpression: { barcode: { $type: 'string' } } }
);

// ---- Virtuals -----------------------------------------------------------------
inventoryItemSchema.virtual('isLowStock').get(function isLowStock() {
  return this.currentStock <= this.reorderLevel;
});

/** Value of stock on hand, in minor currency units. */
inventoryItemSchema.virtual('stockValue').get(function stockValue() {
  return Math.round(Math.max(this.currentStock, 0) * this.averageCost);
});

// ---- Ledger guard hooks ---------------------------------------------------------
const STOCK_WRITE_ERROR =
  'currentStock is ledger-controlled: change it by recording a StockMovement ' +
  '(inventoryService.adjustStock / receivePurchaseOrder / order flows).';

const touchesStock = (obj) => obj != null && Object.prototype.hasOwnProperty.call(obj, 'currentStock');

inventoryItemSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
  async function guardStockUpdates() {
    if (this.getOptions().allowStockWrite) return; // set only by inventory.service
    const update = this.getUpdate() || {};
    const operators = ['$set', '$inc', '$unset', '$mul', '$min', '$max', '$setOnInsert', '$rename'];
    if (touchesStock(update) || operators.some((op) => touchesStock(update[op]))) {
      throw new AppError(400, STOCK_WRITE_ERROR, 'STOCK_LEDGER_ONLY');
    }
  }
);

inventoryItemSchema.pre('save', async function guardStockOnSave() {
  if (this.$locals.allowStockWrite) return;
  // New items start at 0; initial stock is recorded as an 'opening_balance' movement.
  if ((this.isNew && this.currentStock !== 0) || (!this.isNew && this.isModified('currentStock'))) {
    throw new AppError(400, STOCK_WRITE_ERROR, 'STOCK_LEDGER_ONLY');
  }
});

module.exports = mongoose.model('InventoryItem', inventoryItemSchema);
