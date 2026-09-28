const mongoose = require('mongoose');
const { Order, Payment } = require('../models');
const { badRequest, conflict, notFound } = require('../utils/errors');
const { withTransaction } = require('../utils/transaction');

/**
 * Recompute Order.amountPaid / amountRefunded / tipTotal from the Payment ledger.
 * The Payment rows are the truth. The order fields are a cache for fast POS reads, and
 * paymentStatus is derived from them by the Order pre-validate hook.
 */
async function syncOrderPayments(order, session) {
  const rows = await Payment.aggregate([
    { $match: { orderId: new mongoose.Types.ObjectId(String(order._id)), status: 'completed' } },
    { $group: { _id: '$type', amount: { $sum: '$amount' }, tips: { $sum: '$tipAmount' } } },
  ]).session(session);

  const byType = Object.fromEntries(rows.map((r) => [r._id, r]));
  order.amountPaid = byType.payment?.amount || 0;
  order.amountRefunded = byType.refund?.amount || 0;
  order.tipTotal = (byType.payment?.tips || 0) - (byType.refund?.tips || 0);
  return order;
}

/**
 * Take a payment against an order. Split bills are simply several calls.
 * Idempotent when the client sends an idempotencyKey: a retry returns the original payment.
 */
async function recordPayment(orderId, input, userId) {
  return withTransaction(async (session) => {
    if (input.idempotencyKey) {
      const existing = await Payment.findOne({ idempotencyKey: input.idempotencyKey }).session(session);
      if (existing) return { payment: existing, order: await Order.findById(existing.orderId).session(session), replayed: true };
    }

    const order = await Order.findById(orderId).session(session);
    if (!order) throw notFound('Order');
    if (order.status === 'cancelled') throw conflict('Cannot pay a cancelled order', 'ORDER_CANCELLED');

    const amount = Number(input.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw badRequest('amount must be a positive integer (minor units)');
    if (amount > order.balanceDue) {
      throw conflict(`Amount exceeds balance due (${order.balanceDue})`, 'OVERPAYMENT', { balanceDue: order.balanceDue });
    }

    const [payment] = await Payment.create(
      [
        {
          orderId: order._id,
          type: 'payment',
          method: input.method,
          status: 'completed', // card terminals report an already-authorized result
          amount,
          tipAmount: input.tipAmount || 0,
          currency: order.currency,
          cashTendered: input.cashTendered,
          provider: input.provider,
          idempotencyKey: input.idempotencyKey,
          processedBy: userId,
          note: input.note,
        },
      ],
      { session }
    );

    await syncOrderPayments(order, session);
    await order.save({ session });
    return { payment, order, replayed: false };
  });
}

/** Refund (part of) a completed payment. Creates a new 'refund' row and never edits the original. */
async function refundPayment(paymentId, { amount, reason, method }, userId) {
  return withTransaction(async (session) => {
    const original = await Payment.findById(paymentId).session(session);
    if (!original) throw notFound('Payment');
    if (original.type !== 'payment' || original.status !== 'completed') {
      throw conflict('Only completed payments can be refunded', 'NOT_REFUNDABLE');
    }

    const [agg] = await Payment.aggregate([
      { $match: { refundOf: original._id, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]).session(session);
    const refundable = original.amount - (agg?.total || 0);
    const refundAmount = amount == null ? refundable : Number(amount);
    if (!Number.isInteger(refundAmount) || refundAmount <= 0 || refundAmount > refundable) {
      throw badRequest(`Refund amount must be between 1 and ${refundable}`, 'INVALID_REFUND_AMOUNT');
    }

    const [refund] = await Payment.create(
      [
        {
          orderId: original.orderId,
          type: 'refund',
          refundOf: original._id,
          method: method || original.method,
          status: 'completed',
          amount: refundAmount,
          currency: original.currency,
          processedBy: userId,
          note: reason,
        },
      ],
      { session }
    );

    const order = await Order.findById(original.orderId).session(session);
    await syncOrderPayments(order, session);
    await order.save({ session });
    return { refund, order };
  });
}

module.exports = { recordPayment, refundPayment, syncOrderPayments };
