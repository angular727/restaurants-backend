const express = require('express');
const { MenuCategory, MenuItem } = require('../models');
const crudRouter = require('./crud');
const requireRole = require('../middleware/requireRole');
const asyncHandler = require('../utils/asyncHandler');
const { notFound } = require('../utils/errors');

const router = express.Router();

router.use(
  '/categories',
  crudRouter(MenuCategory, {
    fields: ['name', 'description', 'imageUrl', 'sortOrder', 'isActive', 'availableFrom', 'availableTo'],
    filterable: ['isActive'],
    sort: { sortOrder: 1, name: 1 },
  })
);

// Food cost of one portion at current average ingredient costs
router.get(
  '/items/:id/food-cost',
  requireRole('manager', 'chef'),
  asyncHandler(async (req, res) => {
    const item = await MenuItem.findById(req.params.id);
    if (!item) throw notFound('Menu item');
    res.json({ data: { price: item.price, ...(await item.computeFoodCost()) } });
  })
);

// Quick "86" toggle for floor staff during service
router.post(
  '/items/:id/availability',
  requireRole('manager', 'chef', 'waiter'),
  asyncHandler(async (req, res) => {
    const item = await MenuItem.findById(req.params.id);
    if (!item) throw notFound('Menu item');
    item.isAvailable = Boolean(req.body.isAvailable);
    await item.save();
    res.json({ data: item });
  })
);

router.use(
  '/items',
  crudRouter(MenuItem, {
    fields: [
      'categoryId', 'name', 'description', 'sku', 'imageUrl', 'price', 'taxRate', 'tags',
      'dietary', 'allergens', 'preparationTimeMinutes', 'kitchenStation', 'isAvailable',
      'isActive', 'trackInventory', 'recipe', 'sortOrder',
    ],
    filterable: ['categoryId', 'isActive', 'isAvailable'],
    sort: { sortOrder: 1, name: 1 },
    writeRoles: ['manager', 'chef'],
  })
);

module.exports = router;
