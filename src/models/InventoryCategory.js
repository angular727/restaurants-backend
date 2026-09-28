const mongoose = require('mongoose');
const tenantScopePlugin = require('./plugins/tenantScope.plugin');
const softDeletePlugin = require('./plugins/softDelete.plugin');
const { schemaOptions, tenantRef } = require('./schemas/common');

const { Schema } = mongoose;

const inventoryCategorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 500 },
    // Optional one-level nesting, e.g. "Dairy" > "Cheese"
    parentId: tenantRef('InventoryCategory', 'parentId'),
    sortOrder: { type: Number, default: 0 },
  },
  schemaOptions()
);

inventoryCategorySchema.plugin(tenantScopePlugin);
inventoryCategorySchema.plugin(softDeletePlugin);

inventoryCategorySchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false }, collation: { locale: 'en', strength: 2 } }
);
inventoryCategorySchema.index({ tenantId: 1, parentId: 1, sortOrder: 1 });

inventoryCategorySchema.pre('validate', async function noSelfParent() {
  if (this.parentId && this.parentId.equals(this._id)) {
    this.invalidate('parentId', 'A category cannot be its own parent');
  }
});

module.exports = mongoose.model('InventoryCategory', inventoryCategorySchema);
