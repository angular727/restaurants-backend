const express = require('express');
const { Order, Payment, Table } = require('../models');
const orderService = require('../services/order.service');
const paymentService = require('../services/payment.service');
const crudRouter = require('./crud');
const requireRole = require('../middleware/requireRole');
const asyncHandler = require('../utils/asyncHandler');
const { notFound } = require('../utils/errors');
const { parsePagination } = require('../utils/helpers');

const router = express.Router();
const floor = requireRole('manager', 'cashier', 'waiter');
const kitchen = requireRole('manager', 'chef', 'waiter');
const till = requireRole('manager', 'cashier');

// ---- Tables ----------------------------------------------------------------------
router.use(
  '/tables',
  crudRouter(Table, {
    fields: ['name', 'section', 'capacity', 'status', 'position', 'sortOrder', 'isActive', 'assignedWaiterId'],
    filterable: ['section', 'status', 'isActive', 'assignedWaiterId'],
    sort: { section: 1, sortOrder: 1, name: 1 },
  })
);

// ---- Orders ----------------------------------------------------------------------
router.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    for (const key of ['status', 'paymentStatus', 'type', 'tableId', 'waiterId']) if (req.query[key]) filter[key] = req.query[key];
    const data = await Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
    res.json({ data, meta: { page, limit } });
  })
);

router.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id).populate('tableId', 'name section');
    if (!order) throw notFound('Order');
    res.json({ data: order });
  })
);

// body: { type, tableId?, guestCount?, customer?, notes?, items: [{ menuItemId, quantity, notes }] }
router.post(
  '/orders',
  floor,
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await orderService.createOrder(req.body, req.user.id) });
  })
);

router.post(
  '/orders/:id/items',
  floor,
  asyncHandler(async (req, res) => {
    res.json({ data: await orderService.addItems(req.params.id, req.body.items, req.user.id) });
  })
);

// Fires pending lines to the kitchen and deducts stock (default trigger)
router.post(
  '/orders/:id/send',
  floor,
  asyncHandler(async (req, res) => {
    const { order, movements } = await orderService.sendToKitchen(req.params.id, req.user.id);
    res.json({ data: order, meta: { stockMovements: movements.length } });
  })
);

// body: { status: 'preparing'|'ready'|'served' }
router.patch(
  '/orders/:id/items/:lineId/status',
  kitchen,
  asyncHandler(async (req, res) => {
    res.json({ data: await orderService.setItemStatus(req.params.id, req.params.lineId, req.body.status) });
  })
);

// body: { reason, returnToStock }
router.post(
  '/orders/:id/items/:lineId/cancel',
  requireRole('manager', 'cashier'),
  asyncHandler(async (req, res) => {
    res.json({ data: await orderService.cancelItem(req.params.id, req.params.lineId, req.body, req.user.id) });
  })
);

// body: { waiterId }. Hand an open order to another waiter (shift change, table swap).
router.patch(
  '/orders/:id/waiter',
  till,
  asyncHandler(async (req, res) => {
    res.json({ data: await orderService.setWaiter(req.params.id, req.body.waiterId) });
  })
);

router.post(
  '/orders/:id/complete',
  till,
  asyncHandler(async (req, res) => {
    const { order } = await orderService.completeOrder(req.params.id, req.user.id);
    res.json({ data: order });
  })
);

router.post(
  '/orders/:id/cancel',
  requireRole('manager'),
  asyncHandler(async (req, res) => {
    res.json({ data: await orderService.cancelOrder(req.params.id, req.body, req.user.id) });
  })
);

// ---- Payments --------------------------------------------------------------------
router.get(
  '/orders/:id/payments',
  asyncHandler(async (req, res) => {
    res.json({ data: await Payment.find({ orderId: req.params.id }).sort({ createdAt: 1 }) });
  })
);

// body: { method, amount, tipAmount?, cashTendered?, provider?, idempotencyKey? }
// The idempotency key may also be sent as the standard `Idempotency-Key` header.
router.post(
  '/orders/:id/payments',
  till,
  asyncHandler(async (req, res) => {
    const input = { ...req.body, idempotencyKey: req.body.idempotencyKey || req.get('Idempotency-Key') };
    const { payment, order, replayed } = await paymentService.recordPayment(req.params.id, input, req.user.id);
    res.status(replayed ? 200 : 201).json({ data: { payment, order } });
  })
);

router.get(
  '/payments',
  till,
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50 });
    const filter = {};
    if (req.query.method) filter.method = req.query.method;
    if (req.query.from || req.query.to) {
      filter.processedAt = {};
      if (req.query.from) filter.processedAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.processedAt.$lt = new Date(req.query.to);
    }
    const data = await Payment.find(filter).sort({ processedAt: -1 }).skip(skip).limit(limit);
    res.json({ data, meta: { page, limit } });
  })
);

// body: { amount?, reason, method? }. Omitting amount refunds the remaining refundable balance.
router.post(
  '/payments/:id/refund',
  requireRole('manager'),
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await paymentService.refundPayment(req.params.id, req.body, req.user.id) });
  })
);

module.exports = router;
