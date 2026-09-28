/**
 * Tenant resolution middleware: it extracts and injects tenantId.
 *
 * Runs AFTER `authenticate`. For every tenant-scoped request it:
 *   1. EXTRACTS the tenant from, in order of precedence:
 *        - `X-Tenant-ID` header    (ObjectId; what the POS/back-office app sends)
 *        - `X-Tenant-Slug` header  (human-friendly; handy for integrations)
 *        - the subdomain           (golden-fork.yourapp.com → "golden-fork")
 *      Never trust a tenantId in the request BODY. It is ignored, and the plugin fills
 *      tenantId in from context.
 *   2. VERIFIES the tenant exists and is active, and that the user has an ACTIVE
 *      TenantMember row for it (platform admins may enter any tenant).
 *   3. INJECTS it:
 *        - req.tenantId / req.tenant / req.membership, for handlers
 *        - an AsyncLocalStorage context for the REST OF THE REQUEST, which the
 *          tenantScope plugin reads to scope every query automatically.
 *
 * Performance: this is 2 indexed point reads per request. At higher traffic, cache
 * (tenantId, userId) → membership in Redis for ~60 s, or put the membership in a
 * short-lived tenant-specific JWT.
 */
const mongoose = require('mongoose');
const { Tenant, TenantMember } = require('../models');
const { runWithTenant } = require('../utils/tenantContext');
const { badRequest, forbidden, notFound } = require('../utils/errors');

const SUBDOMAIN_IGNORE = new Set(['www', 'api', 'app', 'localhost']);

function extractTenantKey(req) {
  const id = req.get('X-Tenant-ID');
  if (id) return { by: 'id', value: id.trim() };

  const slug = req.get('X-Tenant-Slug');
  if (slug) return { by: 'slug', value: slug.trim().toLowerCase() };

  // tenant.yourapp.com → "tenant" (needs at least 3 labels: sub.domain.tld)
  const parts = (req.hostname || '').split('.');
  if (parts.length >= 3 && !SUBDOMAIN_IGNORE.has(parts[0])) return { by: 'slug', value: parts[0].toLowerCase() };

  return null;
}

async function resolveTenant(req, res, next) {
  try {
    const key = extractTenantKey(req);
    if (!key) throw badRequest('Tenant not specified. Send the X-Tenant-ID header.', 'TENANT_REQUIRED');

    let tenantFilter;
    if (key.by === 'id') {
      if (!mongoose.isValidObjectId(key.value)) throw badRequest('Invalid X-Tenant-ID', 'TENANT_INVALID');
      tenantFilter = { _id: key.value };
    } else {
      tenantFilter = { slug: key.value };
    }

    const tenant = await Tenant.findOne(tenantFilter).lean();
    if (!tenant) throw notFound('Restaurant');
    if (tenant.status !== 'active') throw forbidden(`Restaurant account is ${tenant.status}`);

    // Explicit tenantId in the filter: required here because no tenant context exists yet.
    const membership = await TenantMember.findOne({
      tenantId: tenant._id,
      userId: req.user.id,
      status: 'active',
    }).lean();

    if (!membership && !req.user.isPlatformAdmin) {
      throw forbidden('You are not a member of this restaurant');
    }

    req.tenant = tenant;
    req.tenantId = String(tenant._id);
    req.membership = membership || { role: 'owner', permissions: ['*'], platformAdmin: true };

    // All downstream middleware, handlers and services run inside this context.
    runWithTenant({ tenantId: req.tenantId, userId: req.user.id, role: req.membership.role }, () => next());
  } catch (err) {
    next(err);
  }
}

module.exports = { resolveTenant, extractTenantKey };
