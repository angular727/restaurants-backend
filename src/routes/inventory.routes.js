const express = require('express');
const { InventoryCategory, InventoryItem, StockMovement } = require('../models');
const inventoryService = require('../services/inventory.service');
const crudRouter = require('./crud');
const requireRole = require('../middleware/requireRole');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination } = require('../utils/helpers');

const router = express.Router();
const stockRoles = requireRole('manager', 'inventory_clerk', 'chef');

router.use(
  '/categories',
  crudRouter(InventoryCategory, {
    fields: ['name', 'description', 'parentId', 'sortOrder'],
    sort: { sortOrder: 1, name: 1 },
    writeRoles: ['manager', 'inventory_clerk'],
  })
);

router.get(
  '/items/low-stock',
  asyncHandler(async (_req, res) => {
    res.json({ data: await inventoryService.getLowStockItems() });
  })
);

// GET /items/:id/movements: the item's ledger, newest first
router.get(
  '/items/:id/movements',
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const filter = { inventoryItemId: req.params.id };
    if (req.query.type) filter.type = req.query.type;
    const data = await StockMovement.find(filter).sort({ occurredAt: -1 }).skip(skip).limit(limit);
    res.json({ data, meta: { page, limit } });
  })
);

// POST /items/:id/adjustments  { type: 'waste'|'adjustment'|'opening_balance'|..., quantity, reason, unitCost? }
router.post(
  '/items/:id/adjustments',
  stockRoles,
  asyncHandler(async (req, res) => {
    const { item, movement } = await inventoryService.adjustStock({ ...req.body, inventoryItemId: req.params.id }, req.user.id);
    res.status(201).json({ data: { item, movement } });
  })
);

// POST /items/:id/counts  { countedQuantity, reason? }
router.post(
  '/items/:id/counts',
  stockRoles,
  asyncHandler(async (req, res) => {
    const result = await inventoryService.recordStockCount({ ...req.body, inventoryItemId: req.params.id }, req.user.id);
    res.status(201).json({ data: result });
  })
);

router.get(
  '/items/:id/reconcile',
  requireRole('manager'),
  asyncHandler(async (req, res) => {
    res.json({ data: await inventoryService.reconcileItem(req.params.id) });
  })
);

// Plain CRUD. Note that `currentStock` is NOT in the writable fields.
router.use(
  '/items',
  crudRouter(InventoryItem, {
    fields: [
      'categoryId', 'name', 'sku', 'barcode', 'description', 'unit', 'purchaseUnit',
      'reorderLevel', 'reorderQuantity', 'parLevel', 'preferredSupplierId',
      'storageLocation', 'isPerishable', 'shelfLifeDays', 'isActive',
    ],
    filterable: ['categoryId', 'isActive', 'preferredSupplierId'],
    sort: { name: 1 },
    writeRoles: ['manager', 'inventory_clerk'],
  })
);

module.exports = router;
