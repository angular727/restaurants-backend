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
const { TenantMember } = require('../models');

const router = express.Router();

router.use('/auth', require('./auth.routes'));

const tenantRouter = express.Router();
tenantRouter.use(authenticate, resolveTenant);

tenantRouter.get('/tenant', (req, res) => res.json({ data: req.tenant, membership: req.membership }));
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
