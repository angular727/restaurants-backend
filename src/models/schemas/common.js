/**
 * Shared schema building blocks.
 *
 * MONEY: every monetary amount is an INTEGER in the currency's minor unit (cents, fils,
 * paisa), with the currency held on the Tenant and snapshotted on Orders/Payments.
 * Integers avoid float rounding errors (0.1 + 0.2 !== 0.3) that would otherwise make
 * totals drift by a cent. Only *per-unit costs* of inventory (e.g. cost per gram) may be
 * fractional; anything that is charged or paid is an integer.
 */
const mongoose = require('mongoose');

const { Schema } = mongoose;

function schemaOptions(overrides = {}) {
  return {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(_doc, ret) {
        delete ret._id; // `id` virtual is exposed instead
        return ret;
      },
    },
    toObject: { virtuals: true },
    ...overrides,
  };
}

const isInteger = {
  validator: (v) => v == null || Number.isInteger(v),
  message: '{PATH} must be an integer amount in minor currency units (e.g. cents)',
};

/** Integer money field in minor units. */
function money(extra = {}) {
  return { type: Number, min: 0, default: 0, validate: isInteger, ...extra };
}

/** A percentage 0–100 (e.g. tax rate 8.875). */
function percent(defaultValue = 0, extra = {}) {
  return { type: Number, min: 0, max: 100, default: defaultValue, ...extra };
}

/**
 * ObjectId reference that must point to a document in the SAME tenant.
 * A client could otherwise send another restaurant's categoryId and create a
 * cross-tenant link. The check only runs when the path is new or modified, and uses
 * the document's session so it works inside transactions.
 *
 * Reserve this for low-volume master data. Hot paths (order lines) are checked in services.
 */
function tenantRef(modelName, path, { required = false } = {}) {
  return {
    type: Schema.Types.ObjectId,
    ref: modelName,
    required,
    validate: {
      async validator(value) {
        if (value == null) return true;
        const owner = typeof this.ownerDocument === 'function' ? this.ownerDocument() : this;
        // Update validators run with a Query as `this`, so skip there (we update via save()).
        if (!owner || typeof owner.$session !== 'function' || !owner.tenantId) return true;
        if (!this.isNew && typeof this.isModified === 'function' && !this.isModified(path)) return true;

        const query = mongoose.model(modelName).exists({ _id: value, tenantId: owner.tenantId });
        const session = owner.$session();
        if (session) query.session(session);
        return Boolean(await query);
      },
      message: (props) => `${props.path} does not reference an existing ${modelName} in this restaurant`,
    },
  };
}

const addressSchema = new Schema(
  {
    line1: { type: String, trim: true, maxlength: 200 },
    line2: { type: String, trim: true, maxlength: 200 },
    city: { type: String, trim: true, maxlength: 100 },
    state: { type: String, trim: true, maxlength: 100 },
    postalCode: { type: String, trim: true, maxlength: 20 },
    country: { type: String, trim: true, uppercase: true, match: [/^[A-Z]{2}$/, 'country must be ISO-3166 alpha-2'] },
  },
  { _id: false }
);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = { schemaOptions, money, percent, tenantRef, addressSchema, isInteger, EMAIL_REGEX };
