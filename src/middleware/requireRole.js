const { forbidden } = require('../utils/errors');

/**
 * Role gate for tenant-scoped routes. Must run after resolveTenant.
 *   router.post('/adjustments', requireRole('owner', 'manager', 'inventory_clerk'), handler)
 * Owners and admins always pass.
 */
function requireRole(...roles) {
  const allowed = new Set(['owner', 'admin', ...roles]);
  return (req, _res, next) => {
    const role = req.membership?.role;
    if (!role || !allowed.has(role)) return next(forbidden(`Requires role: ${[...allowed].join(', ')}`));
    return next();
  };
}

module.exports = requireRole;
