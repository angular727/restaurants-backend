const mongoose = require('mongoose');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');
const softDeletePlugin = require('./plugins/softDelete.plugin');
const { schemaOptions, addressSchema, EMAIL_REGEX } = require('./schemas/common');
const { SUPPLIER_PAYMENT_TERMS } = require('../config/enums');

const { Schema } = mongoose;

const supplierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, trim: true, uppercase: true, maxlength: 20 }, // short internal code, e.g. "PRIME"
    contactPerson: { type: String, trim: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, match: [EMAIL_REGEX, 'invalid email'] },
    phone: { type: String, trim: true, maxlength: 30 },
    address: { type: addressSchema, default: () => ({}) },
    taxId: { type: String, trim: true, maxlength: 50 },
    paymentTerms: { type: String, enum: SUPPLIER_PAYMENT_TERMS, default: 'net_30' },
    leadTimeDays: { type: Number, min: 0, max: 365, default: 1 },
    notes: { type: String, trim: true, maxlength: 2000 },
    isActive: { type: Boolean, default: true },
  },
  schemaOptions()
);

supplierSchema.plugin(tenantScopePlugin);
supplierSchema.plugin(softDeletePlugin);

supplierSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false }, collation: { locale: 'en', strength: 2 } }
);
supplierSchema.index(
  { tenantId: 1, code: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, code: { $type: 'string' } } }
);
supplierSchema.index({ tenantId: 1, isActive: 1 });

module.exports = mongoose.model('Supplier', supplierSchema);
