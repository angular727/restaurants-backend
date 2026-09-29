/**
 * Route map
 *
 *   /api/v1/auth/*                        public (register, login) + /me
 *   /api/v1/*  (everything else)          authenticate → resolveTenant → handlers
 *
 * Every handler mounted on `tenantRouter` runs inside the tenant's AsyncLocalStorage
 * context, so the handlers themselves never deal with tenantId.
 */
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { resolveTenant } = require('../middleware/tenant');
const requireRole = require('../middleware/requireRole');
const asyncHandler = require('../utils/asyncHandler');
const { TenantMember, Tenant } = require('../models');
const { getTenantId } = require('../utils/tenantContext');
const { badRequest } = require('../utils/errors');

const router = express.Router();

router.use('/auth', require('./auth.routes'));

const tenantRouter = express.Router();
tenantRouter.use(authenticate, resolveTenant);

tenantRouter.get('/tenant', (req, res) => res.json({ data: req.tenant, membership: req.membership }));

// body: { rate?, pricesIncludeTax?, serviceChargeRate? } — percentages 0-100. Orders snapshot
// these at creation, so changing them only affects orders placed afterwards.
tenantRouter.patch(
  '/tenant/tax',
  requireRole('manager'),
  asyncHandler(async (req, res) => {
    const { rate, pricesIncludeTax, serviceChargeRate } = req.body;
    const set = {};
    if (rate !== undefined) {
      if (typeof rate !== 'number' || rate < 0 || rate > 100) throw badRequest('rate must be a number between 0 and 100');
      set['tax.rate'] = rate;
    }
    if (pricesIncludeTax !== undefined) {
      if (typeof pricesIncludeTax !== 'boolean') throw badRequest('pricesIncludeTax must be a boolean');
      set['tax.pricesIncludeTax'] = pricesIncludeTax;
    }
    if (serviceChargeRate !== undefined) {
      if (typeof serviceChargeRate !== 'number' || serviceChargeRate < 0 || serviceChargeRate > 100) {
        throw badRequest('serviceChargeRate must be a number between 0 and 100');
      }
      set['tax.serviceChargeRate'] = serviceChargeRate;
    }
    if (!Object.keys(set).length) throw badRequest('Nothing to update');

    const tenant = await Tenant.findByIdAndUpdate(getTenantId(), { $set: set }, { new: true, runValidators: true });
    res.json({ data: tenant });
  })
);
tenantRouter.get(
  '/members',
  requireRole('manager'),
  asyncHandler(async (_req, res) => {
    res.json({ data: await TenantMember.find().populate('userId', 'name email') });
  })
);
// Name + role of active staff, for any member (waiter pickers, "served by" labels).
// No emails or permissions: the full list stays on the manager-only /members.
tenantRouter.get(
  '/staff',
  asyncHandler(async (_req, res) => {
    const members = await TenantMember.find({ status: 'active' }).populate('userId', 'name').lean();
    res.json({
      data: members
        .filter((m) => m.userId)
        .map((m) => ({ userId: m.userId._id, name: m.displayName || m.userId.name, role: m.role })),
    });
  })
);

tenantRouter.use('/inventory', require('./inventory.routes'));
tenantRouter.use('/menu', require('./menu.routes'));
tenantRouter.use('/', require('./purchasing.routes')); // /suppliers, /purchase-orders
tenantRouter.use('/', require('./orders.routes')); //     /tables, /orders, /payments

router.use('/', tenantRouter);

module.exports = router;
