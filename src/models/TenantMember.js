/**
 * TenantMember: the many-to-many link between Users and Tenants, carrying the role.
 *
 * Authorization is checked against this collection on every tenant-scoped request (see
 * middleware/tenant.js). A user without an active membership for the requested tenant
 * gets a 403 even with a valid JWT.
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');
const softDeletePlugin = require('./plugins/softDelete.plugin');
const { schemaOptions } = require('./schemas/common');
const { MEMBER_ROLES, MEMBER_STATUS } = require('../config/enums');

const { Schema } = mongoose;

const tenantMemberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: MEMBER_ROLES, required: true },
    // Fine-grained extras on top of the role, e.g. ['orders.void', 'inventory.adjust']
    permissions: { type: [{ type: String, trim: true, maxlength: 64 }], default: [] },
    status: { type: String, enum: MEMBER_STATUS, default: 'active' },
    // A 4-6 digit PIN for quick switching between staff on a shared POS terminal.
    pinHash: { type: String, select: false },
    displayName: { type: String, trim: true, maxlength: 60 }, // shown on tickets, e.g. "Sam K."
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    joinedAt: Date,
  },
  schemaOptions()
);

tenantMemberSchema.plugin(tenantScopePlugin);
tenantMemberSchema.plugin(softDeletePlugin);

// One membership per user per restaurant.
tenantMemberSchema.index(
  { tenantId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
tenantMemberSchema.index({ tenantId: 1, role: 1, status: 1 });
// Deliberately NOT tenant-prefixed: answers "which restaurants can this user access?"
// at login, before any tenant is selected (runs via runAsSystem).
tenantMemberSchema.index({ userId: 1, status: 1 });

tenantMemberSchema.pre('save', async function setJoinedAt() {
  if (this.status === 'active' && !this.joinedAt) this.joinedAt = new Date();
});

tenantMemberSchema.methods.setPin = async function setPin(pin) {
  if (!/^\d{4,6}$/.test(String(pin))) throw new Error('PIN must be 4-6 digits');
  this.pinHash = await bcrypt.hash(String(pin), 10);
};

tenantMemberSchema.methods.comparePin = function comparePin(pin) {
  return this.pinHash ? bcrypt.compare(String(pin), this.pinHash) : Promise.resolve(false);
};

tenantMemberSchema.methods.hasRole = function hasRole(...roles) {
  return this.status === 'active' && roles.includes(this.role);
};

module.exports = mongoose.model('TenantMember', tenantMemberSchema);
