/**
 * Counter: per-tenant, human-friendly sequential numbers (ORD-000042, PO-000007).
 *
 * ObjectIds are unique but useless to read out across a kitchen pass. Each restaurant gets
 * its own sequences, and `$inc` with upsert on a unique (tenantId, key) is atomic. Called
 * with a session, the number is only used if the surrounding transaction commits.
 */
const mongoose = require('mongoose');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');

const { Schema } = mongoose;

const counterSchema = new Schema(
  {
    key: { type: String, required: true, trim: true }, // 'order', 'purchase_order', ...
    seq: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

counterSchema.plugin(tenantScopePlugin);
counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });

/** Atomically increment and return the next value for `key` in the current tenant. */
counterSchema.statics.next = async function next(key, { session = null } = {}) {
  const doc = await this.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
  return doc.seq;
};

counterSchema.statics.format = function format(prefix, seq, width = 6) {
  return `${prefix}-${String(seq).padStart(width, '0')}`;
};

module.exports = mongoose.model('Counter', counterSchema);
