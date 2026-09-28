const express = require('express');
const { Supplier, PurchaseOrder, InventoryItem, Tenant, Counter } = require('../models');
const inventoryService = require('../services/inventory.service');
const crudRouter = require('./crud');
const requireRole = require('../middleware/requireRole');
const asyncHandler = require('../utils/asyncHandler');
const { withTransaction } = require('../utils/transaction');
const { badRequest, conflict, notFound } = require('../utils/errors');
const { parsePagination } = require('../utils/helpers');

const router = express.Router();
const buyer = requireRole('manager', 'inventory_clerk');

router.use(
  '/suppliers',
  crudRouter(Supplier, {
    fields: ['name', 'code', 'contactPerson', 'email', 'phone', 'address', 'taxId', 'paymentTerms', 'leadTimeDays', 'notes', 'isActive'],
    filterable: ['isActive'],
    sort: { name: 1 },
    writeRoles: ['manager', 'inventory_clerk'],
  })
);

// ---- Purchase orders ---------------------------------------------------------------

router.get(
  '/purchase-orders',
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.supplierId) filter.supplierId = req.query.supplierId;
    const data = await PurchaseOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('supplierId', 'name');
    res.json({ data, meta: { page, limit } });
  })
);

router.get(
  '/purchase-orders/:id',
  asyncHandler(async (req, res) => {
    const po = await PurchaseOrder.findById(req.params.id).populate('supplierId', 'name email phone');
    if (!po) throw notFound('Purchase order');
    res.json({ data: po });
  })
);

/**
 * Create a draft PO.
 * body: { supplierId, expectedDeliveryDate, notes, shippingCost,
 *         items: [{ inventoryItemId, quantityOrdered, unitCost, taxRate? }] }
 * Item name, unit and pack conversion are snapshotted from the InventoryItem.
 */
router.post(
  '/purchase-orders',
  buyer,
  asyncHandler(async (req, res) => {
    const { supplierId, items = [], expectedDeliveryDate, notes, shippingCost } = req.body;
    if (!items.length) throw badRequest('items are required');

    const po = await withTransaction(async (session) => {
      const inv = await InventoryItem.find({ _id: { $in: items.map((i) => i.inventoryItemId) } }).session(session).lean();
      const byId = new Map(inv.map((i) => [String(i._id), i]));
      const tenant = await Tenant.findById(req.tenantId).session(session).lean();
      const seq = await Counter.next('purchase_order', { session });

      const doc = new PurchaseOrder({
        poNumber: Counter.format(tenant.settings.poNumberPrefix, seq),
        supplierId,
        expectedDeliveryDate,
        notes,
        shippingCost,
        createdBy: req.user.id,
        items: items.map((line) => {
          const item = byId.get(String(line.inventoryItemId));
          if (!item) throw badRequest(`Inventory item ${line.inventoryItemId} not found`);
          return {
            inventoryItemId: item._id,
            itemName: item.name,
            baseUnit: item.unit,
            purchaseUnit: item.purchaseUnit?.name || item.unit,
            conversionFactor: item.purchaseUnit?.factor || 1,
            quantityOrdered: line.quantityOrdered,
            unitCost: line.unitCost,
            taxRate: line.taxRate,
          };
        }),
      });
      await doc.save({ session });
      return doc;
    });
    res.status(201).json({ data: po });
  })
);

router.post(
  '/purchase-orders/:id/submit',
  requireRole('manager'),
  asyncHandler(async (req, res) => {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) throw notFound('Purchase order');
    po.status = 'submitted';
    po.submittedAt = new Date();
    po.approvedBy = req.user.id;
    await po.save(); // the status transition is validated in the model hook
    res.json({ data: po });
  })
);

// body: { receipts: [{ lineId, quantity, unitCost? }] }. Stock goes up here.
router.post(
  '/purchase-orders/:id/receive',
  buyer,
  asyncHandler(async (req, res) => {
    const result = await inventoryService.receivePurchaseOrder(req.params.id, req.body.receipts, req.user.id);
    res.json({ data: result });
  })
);

router.post(
  '/purchase-orders/:id/cancel',
  requireRole('manager'),
  asyncHandler(async (req, res) => {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) throw notFound('Purchase order');
    if (po.items.some((l) => l.quantityReceived > 0)) {
      throw conflict('Goods already received. Close the PO instead of cancelling it.', 'PO_PARTIALLY_RECEIVED');
    }
    po.status = 'cancelled';
    po.cancelledAt = new Date();
    po.cancelReason = req.body.reason;
    await po.save();
    res.json({ data: po });
  })
);

module.exports = router;
