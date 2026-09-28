/**
 * softDelete plugin
 *
 * Used for MASTER DATA (menu items, inventory items, suppliers, tables, and so on). Old
 * orders, POs and stock movements reference these documents, so hard-deleting them would
 * break history and reports.
 *
 * NOT used for FINANCIAL / AUDIT records (Order, Payment, StockMovement). Those are never
 * deleted. They are cancelled, voided or corrected with a reversing entry.
 *
 * Behaviour:
 *   - Adds isDeleted / deletedAt / deletedBy.
 *   - Read and update queries exclude deleted docs automatically, unless the filter already
 *     mentions `isDeleted` or the query sets the `{ withDeleted: true }` option.
 *   - `doc.softDelete(userId)`, `doc.restore()`.
 *
 * Unique indexes on soft-deletable models use partialFilterExpression { isDeleted: false },
 * so a deleted "Burgers" category does not block creating a new one with the same name.
 */
const mongoose = require('mongoose');

const READ_HOOKS = [
  'countDocuments',
  'distinct',
  'find',
  'findOne',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
];

function softDeletePlugin(schema) {
  schema.add({
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  });

  schema.pre(READ_HOOKS, async function () {
    if (this.getOptions().withDeleted) return;
    if (Object.prototype.hasOwnProperty.call(this.getFilter(), 'isDeleted')) return;
    // Equality on `false` (not `$ne: true`) so the planner can use the partial indexes.
    this.where({ isDeleted: false });
  });

  schema.pre('aggregate', async function () {
    const pipeline = this.pipeline();
    const hasDeletedMatch = pipeline.some((s) => s.$match && 'isDeleted' in s.$match);
    if (hasDeletedMatch) return;
    const first = pipeline[0] || {};
    const mustBeFirst = first.$geoNear || first.$search || first.$vectorSearch;
    pipeline.splice(mustBeFirst ? 1 : 0, 0, { $match: { isDeleted: false } });
  });

  schema.methods.softDelete = function softDelete(userId = null, options = {}) {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = userId;
    return this.save(options);
  };

  schema.methods.restore = function restore(options = {}) {
    this.isDeleted = false;
    this.deletedAt = null;
    this.deletedBy = null;
    return this.save(options);
  };
}

module.exports = softDeletePlugin;
