/**
 * tenantScope plugin: the core of multi-tenant isolation.
 *
 * Strategy: SHARED DATABASE, SHARED COLLECTIONS, `tenantId` DISCRIMINATOR COLUMN.
 * One set of collections serves every restaurant, and each tenant-owned document carries
 * `tenantId`. This scales to thousands of small tenants without a database per tenant or
 * a collection explosion, and each tenant's data stays together on shared indexes.
 * The trade-off is that a forgotten filter leaks data. This plugin makes that hard to do:
 *
 *   1. It adds `tenantId` (ObjectId, required, immutable) to the schema.
 *   2. On save/validate it fills `tenantId` from the request context, and refuses a
 *      document whose tenantId belongs to a different tenant.
 *   3. On every query (find, update, delete, count, distinct) it adds
 *      `{ tenantId: <current> }` to the filter. If a filter names a different tenant, the
 *      query throws.
 *   4. On aggregate it prepends `{ $match: { tenantId } }`.
 *   5. A query with no tenant context and no explicit tenantId throws (fail closed).
 *      Cross-tenant jobs must opt in with `runAsSystem()`.
 *
 * INDEXING: tenantId is indexed as the leading key of every compound index declared on
 * tenant-scoped models, which serves every query that filters on tenantId. The plugin also
 * adds `{ tenantId: 1, createdAt: -1 }` for the default "newest first" listing. A
 * standalone `{ tenantId: 1 }` index would be redundant (it is a prefix of these) and only
 * slow down writes.
 *
 * Not covered: `bulkWrite` and raw `Model.collection.*` calls skip Mongoose middleware.
 * Add tenantId to those by hand.
 */
const mongoose = require('mongoose');
const { getContext } = require('../../utils/tenantContext');
const { AppError } = require('../../utils/errors');

const { ObjectId } = mongoose.Types;

const QUERY_HOOKS = [
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
];

const sameId = (a, b) => String(a) === String(b);
const isPlainId = (v) => typeof v === 'string' || v instanceof ObjectId;

function crossTenantError(modelName) {
  return new AppError(403, `Cross-tenant access blocked on ${modelName}`, 'CROSS_TENANT_ACCESS');
}

function missingScopeError(modelName) {
  return new AppError(
    500,
    `Unscoped query on tenant-scoped model ${modelName}. Run it inside a tenant context, ` +
      'pass tenantId explicitly, or use runAsSystem() for intentional cross-tenant access.',
    'TENANT_SCOPE_MISSING'
  );
}

function tenantScopePlugin(schema) {
  schema.add({
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: [true, 'tenantId is required'],
      immutable: true, // a document can never be moved to another tenant
    },
  });

  schema.index({ tenantId: 1, createdAt: -1 });

  // ---- Documents: save() / create() ---------------------------------------
  // 'validate' runs before 'save', so tenantId is filled in before the `required` check.
  schema.pre('validate', async function () {
    const ctx = getContext();
    if (!ctx || ctx.bypassTenantScope) return;
    if (!this.tenantId) {
      this.tenantId = ctx.tenantId;
    } else if (!sameId(this.tenantId, ctx.tenantId)) {
      throw crossTenantError(this.constructor.modelName);
    }
  });

  schema.pre('insertMany', function (next, docs) {
    const ctx = getContext();
    if (!ctx || ctx.bypassTenantScope) return next();
    for (const doc of Array.isArray(docs) ? docs : [docs]) {
      if (doc.tenantId == null) doc.tenantId = ctx.tenantId;
      else if (!sameId(doc.tenantId, ctx.tenantId)) return next(crossTenantError(this.modelName));
    }
    return next();
  });

  // ---- Queries -------------------------------------------------------------
  schema.pre(QUERY_HOOKS, async function () {
    const ctx = getContext();
    if (ctx?.bypassTenantScope) return;

    const modelName = this.model.modelName;
    const filterTenant = this.getFilter().tenantId;

    if (ctx?.tenantId) {
      if (filterTenant === undefined) {
        this.where({ tenantId: ctx.tenantId });
      } else if (!isPlainId(filterTenant) || !sameId(filterTenant, ctx.tenantId)) {
        throw crossTenantError(modelName);
      }
    } else if (filterTenant === undefined) {
      // No request context, e.g. auth middleware before the tenant is resolved. The caller
      // must name the tenant explicitly.
      throw missingScopeError(modelName);
    }
  });

  // ---- Aggregation ---------------------------------------------------------
  schema.pre('aggregate', async function () {
    const ctx = getContext();
    if (ctx?.bypassTenantScope) return;

    const pipeline = this.pipeline();
    const first = pipeline[0] || {};
    const firstMatchTenant = first.$match?.tenantId;
    const modelName = this._model?.modelName || 'aggregate';

    if (ctx?.tenantId) {
      if (firstMatchTenant !== undefined) {
        if (!sameId(firstMatchTenant, ctx.tenantId)) throw crossTenantError(modelName);
        return;
      }
      // Aggregation pipelines are NOT cast by Mongoose, so this must be a real ObjectId.
      const stage = { $match: { tenantId: new ObjectId(ctx.tenantId) } };
      // $geoNear / $search / $vectorSearch must be first, so insert the match right after them.
      const mustBeFirst = first.$geoNear || first.$search || first.$vectorSearch;
      pipeline.splice(mustBeFirst ? 1 : 0, 0, stage);
    } else if (firstMatchTenant === undefined) {
      throw missingScopeError(modelName);
    }
  });
}

module.exports = tenantScopePlugin;
