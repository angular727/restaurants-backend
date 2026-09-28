/**
 * User = a login identity, GLOBAL across tenants (no tenantId).
 *
 * A consultant, a chain owner or a chef working two restaurants can belong to many tenants
 * with one account. Which restaurants a user may access, and in what role, lives in
 * TenantMember. Keeping identity separate from membership avoids duplicate accounts per
 * restaurant.
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const softDeletePlugin = require('./plugins/softDelete.plugin');
const { schemaOptions, EMAIL_REGEX } = require('./schemas/common');
const { USER_STATUS } = require('../config/enums');
const { badRequest } = require('../utils/errors');

const { Schema } = mongoose;
const BCRYPT_ROUNDS = 12;

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: [EMAIL_REGEX, 'invalid email'],
    },
    passwordHash: { type: String, required: true, select: false }, // never returned unless asked for
    phone: { type: String, trim: true, maxlength: 30 },
    avatarUrl: { type: String, trim: true },
    status: { type: String, enum: USER_STATUS, default: 'active' },
    isPlatformAdmin: { type: Boolean, default: false }, // SaaS staff and can access any tenant
    lastLoginAt: Date,
    lastTenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' }, // pre-selects the restaurant after login
  },
  schemaOptions({
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(_doc, ret) {
        delete ret._id;
        delete ret.passwordHash;
        return ret;
      },
    },
  })
);

userSchema.plugin(softDeletePlugin);

userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });

userSchema.methods.setPassword = async function setPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw badRequest('password must be at least 8 characters', 'WEAK_PASSWORD');
  }
  this.passwordHash = await bcrypt.hash(plain, BCRYPT_ROUNDS);
};

userSchema.methods.comparePassword = function comparePassword(plain) {
  if (!this.passwordHash) throw new Error('passwordHash not selected; query with .select("+passwordHash")');
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.statics.findByEmailWithPassword = function findByEmailWithPassword(email) {
  return this.findOne({ email: String(email).toLowerCase().trim() }).select('+passwordHash');
};

module.exports = mongoose.model('User', userSchema);
