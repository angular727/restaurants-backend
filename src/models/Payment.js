/**
 * Payment: an append-only payments LEDGER, kept separate from Order.
 *
 * WHY REFERENCED (not embedded in Order):
 *   - Payments have a lifecycle of their own (pending → completed / failed, gateway
 *     callbacks, reconciliation with the card processor) and are queried on their own
 *     ("all card payments today" for the end-of-day cash-up).
 *   - One order may have several payments (split bills), and refunds can come days later.
 *   - Strict audit requirements. Rows are never deleted or re-priced.
 *
 * Refunds are separate rows with type 'refund' that point at the original payment through
 * `refundOf`, instead of edits to the original. Order.amountPaid / amountRefunded are
 * denormalized sums maintained by paymentService.syncOrderPayments.
 */
const mongoose = require('mongoose');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');
const { schemaOptions, money } = require('./schemas/common');
const { PAYMENT_METHODS, PAYMENT_TYPES, PAYMENT_STATUS } = require('../config/enums');

const { Schema } = mongoose;

const PAYMENT_TRANSITIONS = {
  pending: ['completed', 'failed', 'voided'],
  completed: ['voided'], // same-day void before settlement; afterwards use a refund
  failed: [],
  voided: [],
};

const paymentSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, immutable: true },
    type: { type: String, enum: PAYMENT_TYPES, default: 'payment', immutable: true },
    refundOf: { type: Schema.Types.ObjectId, ref: 'Payment', immutable: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true, immutable: true },
    status: { type: String, enum: PAYMENT_STATUS, default: 'completed' },

    // Always positive. `type` says which direction the money moved.
    amount: money({ required: true, min: [1, 'amount must be positive'], immutable: true }),
    tipAmount: money({ immutable: true }),
    currency: { type: String, required: true, uppercase: true, immutable: true },

    // Cash handling
    cashTendered: money({ default: undefined }),
    changeDue: money(),

    // Card / wallet gateway details. Never store full card numbers (PCI-DSS).
    provider: {
      name: { type: String, trim: true }, // 'stripe', 'square', 'adyen', ...
      transactionId: { type: String, trim: true },
      authCode: { type: String, trim: true },
      cardBrand: { type: String, trim: true },
      last4: { type: String, match: [/^\d{4}$/, 'last4 must be 4 digits'] },
    },
    failureReason: { type: String, trim: true, maxlength: 500 },

    // Client-generated key. Retrying the same request (flaky Wi-Fi on a handheld) must not
    // charge twice. Enforced by the unique index below.
    idempotencyKey: { type: String, trim: true, maxlength: 100 },

    processedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    processedAt: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 500 },
  },
  schemaOptions()
);

paymentSchema.plugin(tenantScopePlugin);
// No soft delete: financial ledger.

// ---- Indexes --------------------------------------------------------------------
paymentSchema.index({ tenantId: 1, orderId: 1, createdAt: 1 });
paymentSchema.index({ tenantId: 1, processedAt: -1 }); // daily cash-up
paymentSchema.index({ tenantId: 1, method: 1, status: 1, processedAt: -1 }); // takings by method
paymentSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);
paymentSchema.index(
  { tenantId: 1, 'provider.transactionId': 1 },
  { partialFilterExpression: { 'provider.transactionId': { $type: 'string' } } }
); // gateway webhook lookups

// ---- Hooks ----------------------------------------------------------------------
paymentSchema.post('init', function rememberStatus() {
  this.$locals.originalStatus = this.status;
});

paymentSchema.pre('validate', async function validatePayment() {
  if (this.type === 'refund' && !this.refundOf) this.invalidate('refundOf', 'Refunds must reference the original payment');
  if (this.type === 'payment' && this.refundOf) this.invalidate('refundOf', 'Only refunds may reference another payment');

  if (this.isNew && this.method === 'cash' && this.type === 'payment' && this.cashTendered != null) {
    const due = this.amount + (this.tipAmount || 0);
    if (this.cashTendered < due) this.invalidate('cashTendered', 'Cash tendered is less than the amount due');
    else this.changeDue = this.cashTendered - due;
  }

  const from = this.$locals.originalStatus;
  if (!this.isNew && this.isModified('status') && from && !PAYMENT_TRANSITIONS[from].includes(this.status)) {
    this.invalidate('status', `Invalid payment status transition ${from} → ${this.status}`);
  }
});

paymentSchema.post('save', function syncOriginalStatus() {
  this.$locals.originalStatus = this.status;
});

paymentSchema.virtual('signedAmount').get(function signedAmount() {
  return this.type === 'refund' ? -this.amount : this.amount;
});

paymentSchema.statics.TRANSITIONS = PAYMENT_TRANSITIONS;

module.exports = mongoose.model('Payment', paymentSchema);
