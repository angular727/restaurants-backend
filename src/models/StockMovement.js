/**
 * StockMovement: the immutable inventory LEDGER.
 *
 * WHY A SEPARATE COLLECTION (not embedded in InventoryItem):
 *   - Volume: every order line fired to the kitchen writes one movement per ingredient.
 *     A busy restaurant writes thousands a day, and embedding would hit the 16 MB document
 *     limit and turn InventoryItem into a hot, ever-growing document.
 *   - Access pattern: movements are queried by time range, type and reference (reports,
 *     COGS, audits), not loaded together with the item.
 *   - Retention: an old ledger can be archived or moved to Online Archive without touching
 *     master data.
 *
 * IMMUTABILITY: movements are append-only. Mistakes are fixed with a compensating entry
 * (e.g. an 'adjustment' or 'sale_reversal'), never by editing or deleting a row. The hooks
 * below enforce this. That is what makes the ledger a trustworthy audit trail.
 *
 * SIGN CONVENTION: `quantity` is signed in the item's BASE unit (+ into stock, − out).
 * The pre-validate hook checks the sign matches the movement type.
 */
const mongoose = require('mongoose');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');
const { schemaOptions } = require('./schemas/common');
const {
  STOCK_MOVEMENT_TYPE_VALUES,
  INBOUND_MOVEMENTS,
  OUTBOUND_MOVEMENTS,
  STOCK_REFERENCE_KINDS,
  UNITS,
} = require('../config/enums');
const { AppError } = require('../utils/errors');

const { Schema } = mongoose;

const stockMovementSchema = new Schema(
  {
    inventoryItemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    type: { type: String, enum: STOCK_MOVEMENT_TYPE_VALUES, required: true },
    quantity: {
      type: Number,
      required: true,
      validate: { validator: (v) => Number.isFinite(v) && v !== 0, message: 'quantity must be a non-zero number' },
    },
    unit: { type: String, enum: UNITS, required: true }, // snapshot of the item's base unit

    // Cost per base unit at the time of the movement (minor units, may be fractional).
    // Outbound movements use the item's averageCost, so SUM(totalCost) of sale_deductions = COGS.
    unitCost: { type: Number, min: 0, default: 0 },
    totalCost: { type: Number, default: 0 }, // signed, rounded to minor units
    balanceAfter: { type: Number, required: true }, // running balance, handy for audits and charts

    // What caused this movement. `refPath` lets populate() resolve the right model.
    reference: {
      kind: { type: String, enum: STOCK_REFERENCE_KINDS, default: 'Manual' },
      id: { type: Schema.Types.ObjectId, refPath: 'reference.kind' },
      lineIds: { type: [Schema.Types.ObjectId], default: undefined }, // order/PO lines involved
    },
    reason: { type: String, trim: true, maxlength: 500 },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    occurredAt: { type: Date, default: Date.now },
  },
  // Immutable ledger: there is no updatedAt.
  schemaOptions({ timestamps: { createdAt: true, updatedAt: false } })
);

stockMovementSchema.plugin(tenantScopePlugin);
// No softDelete plugin: ledger rows are never deleted.

// ---- Indexes --------------------------------------------------------------------
// Item history ("show me every movement of Beef Patty, newest first")
stockMovementSchema.index({ tenantId: 1, inventoryItemId: 1, occurredAt: -1 });
// Reports by type over time (waste report, COGS for a period)
stockMovementSchema.index({ tenantId: 1, type: 1, occurredAt: -1 });
// "Which movements did order X / PO Y produce?" Used for reversals and drill-down.
stockMovementSchema.index({ tenantId: 1, 'reference.kind': 1, 'reference.id': 1 });

stockMovementSchema.virtual('direction').get(function direction() {
  return this.quantity > 0 ? 'in' : 'out';
});

// ---- Hooks ----------------------------------------------------------------------
stockMovementSchema.pre('validate', async function checkSignAndCost() {
  if (INBOUND_MOVEMENTS.includes(this.type) && this.quantity < 0) {
    this.invalidate('quantity', `${this.type} movements must have a positive quantity`);
  }
  if (OUTBOUND_MOVEMENTS.includes(this.type) && this.quantity > 0) {
    this.invalidate('quantity', `${this.type} movements must have a negative quantity`);
  }
  if (['adjustment', 'waste'].includes(this.type) && !this.reason) {
    this.invalidate('reason', `A reason is required for ${this.type} movements`);
  }
  this.totalCost = Math.round(this.quantity * (this.unitCost || 0));
});

stockMovementSchema.pre('save', async function appendOnly() {
  if (!this.isNew) {
    throw new AppError(400, 'Stock movements are immutable; record a correcting movement instead', 'LEDGER_IMMUTABLE');
  }
});

stockMovementSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  async function blockMutations() {
    throw new AppError(400, 'Stock movements are immutable; record a correcting movement instead', 'LEDGER_IMMUTABLE');
  }
);

module.exports = mongoose.model('StockMovement', stockMovementSchema);
