/**
 * PurchaseOrder with its line items EMBEDDED.
 *
 * WHY EMBED PurchaseOrderItems:
 *   - A PO and its lines are created, approved, sent and received as one unit.
 *   - The number of lines is bounded (tens, rarely hundreds).
 *   - Totals and status stay consistent in a single atomic document write.
 * Each line still has its own `_id`, so partial receipts and stock movements can point to
 * the exact line (StockMovement.reference.lineIds).
 *
 * Line fields such as item name, unit and conversion factor are SNAPSHOTS taken when the
 * PO is drafted, so the PO stays accurate after the inventory item is renamed or re-packed.
 *
 * Stock only increases when goods are RECEIVED (inventoryService.receivePurchaseOrder),
 * never when the PO is created or submitted.
 */
const mongoose = require('mongoose');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');
const softDeletePlugin = require('./plugins/softDelete.plugin');
const { schemaOptions, money, percent, tenantRef } = require('./schemas/common');
const { PO_STATUS, PO_TRANSITIONS, UNITS } = require('../config/enums');

const { Schema } = mongoose;

const purchaseOrderItemSchema = new Schema(
  {
    inventoryItemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    itemName: { type: String, required: true, trim: true }, // snapshot
    baseUnit: { type: String, enum: UNITS, required: true }, // snapshot of InventoryItem.unit
    purchaseUnit: { type: String, trim: true, default: 'unit' }, // "case", "kg", ...
    conversionFactor: { type: Number, required: true, min: 0.0001, default: 1 }, // base units per purchase unit

    quantityOrdered: { type: Number, required: true, min: [0.0001, 'quantity must be > 0'] }, // purchase units
    quantityReceived: { type: Number, min: 0, default: 0 }, // purchase units
    unitCost: money({ required: true }), // per PURCHASE unit, minor units
    taxRate: percent(0),
    lineTotal: money(), // computed by hook
    note: { type: String, trim: true, maxlength: 300 },
  },
  {
    _id: true,
    // Expose `id` like top-level documents do, so the frontend never deals with `_id`.
    toJSON: { virtuals: true, versionKey: false, transform: (_doc, ret) => { delete ret._id; return ret; } },
  }
);

purchaseOrderItemSchema.virtual('quantityOutstanding').get(function quantityOutstanding() {
  return Math.max(this.quantityOrdered - this.quantityReceived, 0);
});

const purchaseOrderSchema = new Schema(
  {
    poNumber: { type: String, required: true, trim: true },
    supplierId: tenantRef('Supplier', 'supplierId', { required: true }),
    status: { type: String, enum: PO_STATUS, default: 'draft' },

    items: {
      type: [purchaseOrderItemSchema],
      validate: { validator: (arr) => arr.length > 0 && arr.length <= 500, message: 'A PO needs 1-500 lines' },
    },

    subtotal: money(),
    taxTotal: money(),
    shippingCost: money(),
    grandTotal: money(),

    expectedDeliveryDate: Date,
    submittedAt: Date,
    receivedAt: Date, // fully received
    closedAt: Date,
    cancelledAt: Date,
    cancelReason: { type: String, trim: true, maxlength: 500 },
    supplierReference: { type: String, trim: true, maxlength: 60 }, // supplier's invoice / delivery-note no.
    notes: { type: String, trim: true, maxlength: 2000 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  schemaOptions()
);

purchaseOrderSchema.plugin(tenantScopePlugin);
purchaseOrderSchema.plugin(softDeletePlugin); // only drafts may be deleted (enforced in hook)

// ---- Indexes --------------------------------------------------------------------
purchaseOrderSchema.index({ tenantId: 1, poNumber: 1 }, { unique: true });
purchaseOrderSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
purchaseOrderSchema.index({ tenantId: 1, supplierId: 1, createdAt: -1 });
purchaseOrderSchema.index({ tenantId: 1, 'items.inventoryItemId': 1 }); // purchase history of an item

// ---- Hooks ----------------------------------------------------------------------
// Remember the status as loaded, so transitions can be validated on save.
purchaseOrderSchema.post('init', function rememberStatus() {
  this.$locals.originalStatus = this.status;
});

purchaseOrderSchema.pre('validate', async function computeTotalsAndCheckStatus() {
  let subtotal = 0;
  let taxTotal = 0;
  for (const line of this.items) {
    if (line.quantityReceived > line.quantityOrdered) {
      this.invalidate('items', `Line "${line.itemName}": received exceeds ordered quantity`);
    }
    const net = Math.round(line.quantityOrdered * line.unitCost);
    const tax = Math.round((net * line.taxRate) / 100);
    line.lineTotal = net + tax;
    subtotal += net;
    taxTotal += tax;
  }
  this.subtotal = subtotal;
  this.taxTotal = taxTotal;
  this.grandTotal = subtotal + taxTotal + (this.shippingCost || 0);

  const from = this.$locals.originalStatus;
  if (!this.isNew && this.isModified('status') && from && !PO_TRANSITIONS[from].includes(this.status)) {
    this.invalidate('status', `Invalid PO status transition ${from} → ${this.status}`);
  }
  if (!this.isNew && from && from !== 'draft' && this.isModified('isDeleted') && this.isDeleted) {
    this.invalidate('isDeleted', 'Only draft purchase orders can be deleted; cancel it instead');
  }
});

purchaseOrderSchema.post('save', function syncOriginalStatus() {
  this.$locals.originalStatus = this.status;
});

purchaseOrderSchema.virtual('isFullyReceived').get(function isFullyReceived() {
  return this.items.length > 0 && this.items.every((l) => l.quantityReceived >= l.quantityOrdered);
});

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
