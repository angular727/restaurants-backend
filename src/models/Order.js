/**
 * Order (POS ticket / bill) with OrderItems EMBEDDED.
 *
 * WHY EMBED OrderItems:
 *   - The POS, kitchen display and receipt always need the whole order, and one read
 *     returns it.
 *   - Adding lines, changing line status and recalculating totals are atomic
 *     single-document updates, so there is no window where totals don't match the lines.
 *   - Lines are bounded (a very large banquet ticket is still a few hundred lines).
 * Reporting across lines ("top sellers this month") uses `$unwind: '$items'` with the
 * `{ tenantId, createdAt }` index. For heavy analytics, stream orders to a warehouse.
 *
 * SNAPSHOTS: name, price and tax rate are copied from MenuItem onto each line, and currency
 * and tax settings from the Tenant onto the order. Editing the menu tomorrow must not
 * change yesterday's receipts.
 *
 * NO SOFT DELETE: orders are financial records. They are `cancelled`, never deleted.
 *
 * INVENTORY: each line tracks whether its ingredients were deducted and exactly what it
 * consumed (`inventoryConsumed`). That makes deduction idempotent (a line is never deducted
 * twice) and reversals exact (we return what was taken, even if the recipe changed since).
 * See services/inventory.service.js.
 */
const mongoose = require('mongoose');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');
const { schemaOptions, money, percent, addressSchema } = require('./schemas/common');
const {
  ORDER_TYPES,
  ORDER_SOURCES,
  ORDER_STATUS,
  ORDER_TRANSITIONS,
  ORDER_ITEM_STATUS,
  ORDER_PAYMENT_STATUS,
} = require('../config/enums');
const { percentOf } = require('../utils/helpers');

const { Schema } = mongoose;

const consumptionSchema = new Schema(
  {
    inventoryItemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    quantity: { type: Number, required: true, min: 0 }, // base units consumed by this whole line
  },
  { _id: false }
);

/**
 * Per-line customization on top of the menu item's recipe, e.g. "+2 egg" or "−10g lettuce".
 * The MENU RECIPE NEVER CHANGES — this only adjusts what one order line consumes and costs.
 *   'add':    an extra ingredient (in or out of the recipe), `quantity` base units PER PORTION,
 *             on top of whatever the recipe already includes (no wastage% applied).
 *   'remove': REDUCES a recipe ingredient's own per-portion quantity by `quantity` base units;
 *             a value at or above the recipe's amount removes it from this line entirely.
 *             Only valid for an ingredient that IS in the recipe.
 * name/unit are snapshotted so the ticket and receipt read correctly even if the ingredient
 * is renamed later. See inventory.service.js#deductForOrder for how these affect stock.
 */
const orderItemModifierSchema = new Schema(
  {
    inventoryItemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 }, // snapshot
    unit: { type: String, trim: true }, // snapshot of the ingredient's base unit, for display
    action: { type: String, enum: ['add', 'remove'], required: true },
    quantity: { type: Number, min: 0, default: 0 }, // 'add' only: extra base units per portion
    priceDelta: money(), // extra charge per portion, minor units (usually 0 for 'remove')
  },
  { _id: false }
);

const orderItemSchema = new Schema(
  {
    menuItemId: { type: Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    name: { type: String, required: true, trim: true }, // snapshot
    kitchenStation: { type: String, trim: true }, // snapshot, for KDS routing
    unitPrice: money({ required: true }), // snapshot, minor units
    quantity: {
      type: Number,
      required: true,
      min: [1, 'quantity must be at least 1'],
      max: 999,
      validate: { validator: Number.isInteger, message: 'quantity must be a whole number' },
    },
    taxRate: percent(0), // snapshot
    discountAmount: money(), // line-level discount (minor units)
    notes: { type: String, trim: true, maxlength: 300 }, // free-text kitchen note, e.g. "medium rare"
    // Structured ingredient customizations for this line only (see orderItemModifierSchema).
    modifiers: { type: [orderItemModifierSchema], default: [] },
    status: { type: String, enum: ORDER_ITEM_STATUS, default: 'pending' },

    // Computed by the pre-validate hook
    lineSubtotal: money(), // unitPrice × quantity
    taxAmount: money(),
    lineTotal: money(), // amount charged for this line

    // Inventory bookkeeping (see header)
    inventoryDeducted: { type: Boolean, default: false },
    inventoryConsumed: { type: [consumptionSchema], default: [] },
    inventoryReturned: { type: Boolean, default: false },

    addedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    sentAt: Date,
    servedAt: Date,
    cancelledAt: Date,
    cancelReason: { type: String, trim: true, maxlength: 300 },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    _id: true,
    timestamps: false,
    // Expose `id` like top-level documents do, so the frontend never deals with `_id`.
    toJSON: { virtuals: true, versionKey: false, transform: (_doc, ret) => { delete ret._id; return ret; } },
  }
);

const orderSchema = new Schema(
  {
    orderNumber: { type: String, required: true, trim: true },
    type: { type: String, enum: ORDER_TYPES, required: true },
    source: { type: String, enum: ORDER_SOURCES, default: 'pos' },
    status: { type: String, enum: ORDER_STATUS, default: 'open' },
    paymentStatus: { type: String, enum: ORDER_PAYMENT_STATUS, default: 'unpaid' },

    tableId: { type: Schema.Types.ObjectId, ref: 'Table', default: null },
    guestCount: { type: Number, min: 1, max: 500, default: 1 },
    customer: {
      name: { type: String, trim: true, maxlength: 120 },
      phone: { type: String, trim: true, maxlength: 30 },
      email: { type: String, trim: true, lowercase: true, maxlength: 254 },
      address: { type: addressSchema, default: undefined },
      deliveryNotes: { type: String, trim: true, maxlength: 500 },
    },

    items: { type: [orderItemSchema], default: [] },

    // Snapshots of tenant settings at order creation
    currency: { type: String, required: true, uppercase: true },
    pricesIncludeTax: { type: Boolean, default: false },
    serviceChargeRate: percent(0),

    // Totals (minor units), maintained by the pre-validate hook
    subtotal: money(),
    discountTotal: money(),
    taxTotal: money(),
    serviceCharge: money(),
    grandTotal: money(),
    // Maintained by paymentService from the Payment ledger
    amountPaid: money(),
    amountRefunded: money(),
    tipTotal: money(),

    notes: { type: String, trim: true, maxlength: 1000 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' }, // who entered the order (audit)
    // Who serves the guests (sales by waiter, tips). Defaults to the table's assigned waiter,
    // then to createdBy. Orders from before this field have null; treat createdBy as their waiter.
    waiterId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    openedAt: { type: Date, default: Date.now },
    firstSentAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    cancelReason: { type: String, trim: true, maxlength: 500 },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  schemaOptions()
);

orderSchema.plugin(tenantScopePlugin);

// ---- Indexes --------------------------------------------------------------------
orderSchema.index({ tenantId: 1, orderNumber: 1 }, { unique: true });
// POS "open orders" screen, kitchen display
orderSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
// Table view: the open order for table X
orderSchema.index({ tenantId: 1, tableId: 1, status: 1 });
// Cashier: unpaid / partially paid bills
orderSchema.index({ tenantId: 1, paymentStatus: 1, createdAt: -1 });
// End-of-day sales reports
orderSchema.index({ tenantId: 1, completedAt: -1 });
// Staff performance
orderSchema.index({ tenantId: 1, createdBy: 1, createdAt: -1 });
// Sales by waiter
orderSchema.index({ tenantId: 1, waiterId: 1, createdAt: -1 });

// ---- Virtuals -------------------------------------------------------------------
orderSchema.virtual('netPaid').get(function netPaid() {
  return (this.amountPaid || 0) - (this.amountRefunded || 0);
});

orderSchema.virtual('balanceDue').get(function balanceDue() {
  return Math.max((this.grandTotal || 0) - this.netPaid, 0);
});

orderSchema.virtual('activeItems').get(function activeItems() {
  return (this.items || []).filter((i) => i.status !== 'cancelled');
});

// ---- Methods --------------------------------------------------------------------
/**
 * Recompute line and order totals from the lines. Runs on every validate, so totals can
 * never drift from the items. All values are integers in minor units.
 *
 *  - Tax-exclusive pricing (US): tax = net × rate, and the guest pays net + tax.
 *  - Tax-inclusive pricing (VAT): the price already contains tax, so
 *    tax = net − net / (1 + rate), and the guest pays net.
 *  - Service charge is a percentage of the pre-tax amount.
 *  - Order-level promotions should be spread across lines as `discountAmount`, so tax is
 *    calculated on the discounted amount per line.
 */
orderSchema.methods.recalculateTotals = function recalculateTotals() {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  let linesTotal = 0;

  for (const line of this.items) {
    if (line.status === 'cancelled') {
      line.lineSubtotal = 0;
      line.taxAmount = 0;
      line.lineTotal = 0;
      continue;
    }
    // Modifiers adjust the price per portion (e.g. "+2 egg" = +$1.00 each), then scale by quantity.
    const modifierDelta = (line.modifiers || []).reduce((sum, m) => sum + (m.priceDelta || 0), 0);
    line.lineSubtotal = (line.unitPrice + modifierDelta) * line.quantity;
    const discount = Math.min(line.discountAmount || 0, line.lineSubtotal);
    const net = line.lineSubtotal - discount;
    if (this.pricesIncludeTax) {
      line.taxAmount = net - Math.round(net / (1 + line.taxRate / 100));
      line.lineTotal = net;
    } else {
      line.taxAmount = percentOf(net, line.taxRate);
      line.lineTotal = net + line.taxAmount;
    }
    subtotal += line.lineSubtotal;
    discountTotal += discount;
    taxTotal += line.taxAmount;
    linesTotal += line.lineTotal;
  }

  const preTax = linesTotal - taxTotal; // the same formula works for inclusive and exclusive pricing
  this.subtotal = subtotal;
  this.discountTotal = discountTotal;
  this.taxTotal = taxTotal;
  this.serviceCharge = percentOf(preTax, this.serviceChargeRate || 0);
  this.grandTotal = linesTotal + this.serviceCharge;
  return this;
};

orderSchema.methods.derivePaymentStatus = function derivePaymentStatus() {
  const net = this.netPaid;
  if (net <= 0) this.paymentStatus = this.amountRefunded > 0 ? 'refunded' : 'unpaid';
  else if (net < this.grandTotal) this.paymentStatus = 'partially_paid';
  else this.paymentStatus = 'paid';
  return this.paymentStatus;
};

orderSchema.methods.canTransitionTo = function canTransitionTo(next) {
  const from = this.$locals.originalStatus || this.status;
  return from === next || ORDER_TRANSITIONS[from]?.includes(next);
};

// ---- Hooks ----------------------------------------------------------------------
orderSchema.post('init', function rememberStatus() {
  this.$locals.originalStatus = this.status;
});

orderSchema.pre('validate', async function validateOrder() {
  // Type-specific requirements
  if (this.type === 'dine_in' && !this.tableId) this.invalidate('tableId', 'Dine-in orders require a table');
  if (this.type !== 'dine_in' && this.tableId) this.invalidate('tableId', 'Only dine-in orders can have a table');
  if (this.type === 'delivery' && (!this.customer?.phone || !this.customer?.address?.line1)) {
    this.invalidate('customer', 'Delivery orders require customer phone and address');
  }

  // Status machine
  const from = this.$locals.originalStatus;
  if (!this.isNew && this.isModified('status') && from && !ORDER_TRANSITIONS[from].includes(this.status)) {
    this.invalidate('status', `Invalid order status transition ${from} → ${this.status}`);
  }
  if (!this.isNew && ['completed', 'cancelled'].includes(from) && this.isModified('items')) {
    this.invalidate('items', `Cannot modify items of a ${from} order`);
  }

  this.recalculateTotals();
  this.derivePaymentStatus();
});

orderSchema.post('save', function syncOriginalStatus() {
  this.$locals.originalStatus = this.status;
});

module.exports = mongoose.model('Order', orderSchema);
