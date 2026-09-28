/**
 * Request-scoped tenant context built on AsyncLocalStorage.
 *
 * The tenant middleware calls `runWithTenant({ tenantId, userId, role }, next)`. Everything
 * that runs inside that request, including every Mongoose query and every `await` in
 * services, can then read the current tenant without passing `tenantId` through each
 * function. The tenantScope plugin reads it to add `tenantId` to queries automatically
 * (see models/plugins/tenantScope.plugin.js).
 *
 * `runAsSystem` is the explicit escape hatch for cross-tenant work such as auth lookups,
 * platform-admin reports and cron jobs. Grep for it when auditing tenant isolation.
 *
 * GOTCHA: Mongoose queries are lazy. `runAsSystem(() => Model.find())` returns an
 * unexecuted Query, which then runs OUTSIDE the context when awaited. Start the work
 * inside the callback: `runAsSystem(() => Model.find().exec())` or an async function.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function runWithTenant({ tenantId, userId = null, role = null }, fn) {
  if (!tenantId) throw new Error('runWithTenant requires a tenantId');
  return storage.run({ tenantId: String(tenantId), userId, role, bypassTenantScope: false }, fn);
}

function runAsSystem(fn) {
  return storage.run({ tenantId: null, userId: null, role: 'system', bypassTenantScope: true }, fn);
}

function getContext() {
  return storage.getStore() || null;
}

function getTenantId() {
  return getContext()?.tenantId || null;
}

module.exports = { runWithTenant, runAsSystem, getContext, getTenantId };
