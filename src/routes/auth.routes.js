/**
 * Public auth endpoints. These run WITHOUT a tenant context, so tenant-scoped queries
 * here either pass tenantId explicitly or use runAsSystem().
 */
const express = require('express');
const { User, Tenant, TenantMember } = require('../models');
const { authenticate, signToken } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { withTransaction } = require('../utils/transaction');
const { runAsSystem } = require('../utils/tenantContext');
const { badRequest, unauthorized } = require('../utils/errors');

const router = express.Router();

/** Onboarding: create the owner account, the restaurant (tenant) and the owner membership in one go. */
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { name, email, password, restaurant = {} } = req.body;
    if (!restaurant.name || !restaurant.slug) throw badRequest('restaurant.name and restaurant.slug are required');

    const result = await withTransaction(async (session) => {
      const user = new User({ name, email });
      await user.setPassword(password);
      await user.save({ session });

      const [tenant] = await Tenant.create(
        [
          {
            name: restaurant.name,
            slug: restaurant.slug,
            currency: restaurant.currency,
            timezone: restaurant.timezone,
            ownerId: user._id,
            subscription: { plan: 'free', status: 'trialing', trialEndsAt: new Date(Date.now() + 14 * 864e5) },
          },
        ],
        { session }
      );

      // Explicit tenantId: no tenant context exists during onboarding.
      await TenantMember.create([{ tenantId: tenant._id, userId: user._id, role: 'owner', status: 'active' }], { session });
      return { user, tenant };
    });

    res.status(201).json({ token: signToken(result.user), user: result.user, tenant: result.tenant });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) throw badRequest('email and password are required');
    const user = await User.findByEmailWithPassword(email);
    // Same error for "no such user" and "wrong password", so accounts can't be enumerated.
    if (!user || user.status !== 'active' || !(await user.comparePassword(password))) {
      throw unauthorized('Invalid email or password');
    }
    user.lastLoginAt = new Date();
    await user.save();
    res.json({ token: signToken(user), user });
  })
);

/** The restaurants this user can access, for the "choose restaurant" screen after login. */
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    // Cross-tenant by nature, so this is an explicit system query.
    const memberships = await runAsSystem(() =>
      TenantMember.find({ userId: req.user.id, status: 'active' })
        .populate({ path: 'tenantId', select: 'name slug currency status' })
        .lean()
        .exec() // .exec() INSIDE the callback: a bare Query would run later, outside the system context
    );
    res.json({
      user: req.user,
      restaurants: memberships
        .filter((m) => m.tenantId)
        .map((m) => ({ tenantId: m.tenantId._id, name: m.tenantId.name, slug: m.tenantId.slug, role: m.role })),
    });
  })
);

module.exports = router;
