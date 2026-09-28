const crypto = require('node:crypto');
const mongoose = require('mongoose');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');
const softDeletePlugin = require('./plugins/softDelete.plugin');
const { schemaOptions } = require('./schemas/common');
const { TABLE_STATUS } = require('../config/enums');

const { Schema } = mongoose;

const tableSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 30 }, // "T12", "Bar 3"
    section: { type: String, trim: true, maxlength: 40, default: 'Main' }, // "Patio", "Upstairs"
    capacity: { type: Number, required: true, min: 1, max: 50 },
    status: { type: String, enum: TABLE_STATUS, default: 'available' },
    // The single open order currently seated here (null when free). Set atomically by
    // orderService.createOrder so two waiters can't open the same table at once.
    currentOrderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    // Waiter responsible for this table this shift. New orders on the table default to them.
    assignedWaiterId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      validate: {
        async validator(userId) {
          if (userId == null) return true;
          const exists = await mongoose
            .model('TenantMember')
            .exists({ tenantId: this.tenantId, userId, status: 'active' })
            .session(this.$session() ?? null);
          return Boolean(exists);
        },
        message: 'assignedWaiterId must be an active member of this restaurant',
      },
    },
    // Random token printed as a QR code on the table for guest self-ordering.
    qrToken: { type: String, default: () => crypto.randomBytes(12).toString('base64url') },
    position: { x: { type: Number, default: 0 }, y: { type: Number, default: 0 } }, // floor-plan editor
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  schemaOptions()
);

tableSchema.plugin(tenantScopePlugin);
tableSchema.plugin(softDeletePlugin);

tableSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false }, collation: { locale: 'en', strength: 2 } }
);
tableSchema.index({ tenantId: 1, section: 1, sortOrder: 1 });
tableSchema.index({ tenantId: 1, status: 1 });
// GLOBAL on purpose: a guest scanning a QR code has no tenant context yet, and the token
// identifies both the restaurant and the table (resolve it via runAsSystem).
tableSchema.index({ qrToken: 1 }, { unique: true });

tableSchema.virtual('isFree').get(function isFree() {
  return this.status === 'available' && !this.currentOrderId;
});

module.exports = mongoose.model('Table', tableSchema);
