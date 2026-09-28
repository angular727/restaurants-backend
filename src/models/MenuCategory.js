const mongoose = require('mongoose');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');
const softDeletePlugin = require('./plugins/softDelete.plugin');
const { schemaOptions } = require('./schemas/common');

const { Schema } = mongoose;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const menuCategorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 500 },
    imageUrl: { type: String, trim: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    // Optional daypart window in the tenant's timezone, e.g. Breakfast 07:00-11:30
    availableFrom: { type: String, match: [HHMM, 'use HH:mm'] },
    availableTo: { type: String, match: [HHMM, 'use HH:mm'] },
  },
  schemaOptions()
);

menuCategorySchema.plugin(tenantScopePlugin);
menuCategorySchema.plugin(softDeletePlugin);

menuCategorySchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false }, collation: { locale: 'en', strength: 2 } }
);
menuCategorySchema.index({ tenantId: 1, isActive: 1, sortOrder: 1 });

module.exports = mongoose.model('MenuCategory', menuCategorySchema);
