/**
 * Tenant = one restaurant (the SaaS customer).
 *
 * This is the ROOT of tenancy, so it has no tenantId of its own and is not tenant-scoped.
 * Its _id is the `tenantId` stamped on every other restaurant-owned document.
 *
 * Settings that change behaviour (tax, service charge, inventory deduction trigger) live
 * here. Orders SNAPSHOT the ones they use, so later settings changes don't rewrite
 * historical bills.
 */
const mongoose = require('mongoose');
const softDeletePlugin = require('./plugins/softDelete.plugin');
const { schemaOptions, percent, addressSchema, EMAIL_REGEX } = require('./schemas/common');
const {
  TENANT_STATUS,
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
  INVENTORY_DEDUCTION_TRIGGERS,
} = require('../config/enums');

const { Schema } = mongoose;

function isValidTimeZone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const tenantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // URL-safe identifier, usable for subdomain routing (golden-fork.yourapp.com)
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 60,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug may only contain a-z, 0-9 and single hyphens'],
    },
    legalName: { type: String, trim: true, maxlength: 200 },
    contact: {
      email: { type: String, trim: true, lowercase: true, match: [EMAIL_REGEX, 'invalid email'] },
      phone: { type: String, trim: true, maxlength: 30 },
      website: { type: String, trim: true, maxlength: 200 },
    },
    address: { type: addressSchema, default: () => ({}) },

    currency: { type: String, uppercase: true, default: 'USD', match: [/^[A-Z]{3}$/, 'currency must be ISO-4217'] },
    timezone: { type: String, default: 'UTC', validate: { validator: isValidTimeZone, message: 'invalid IANA timezone' } },
    locale: { type: String, default: 'en-US' },

    tax: {
      rate: percent(0), // default sales tax %, a menu item may override it
      pricesIncludeTax: { type: Boolean, default: false }, // VAT-style inclusive pricing
      serviceChargeRate: percent(0),
      taxId: { type: String, trim: true, maxlength: 50 },
    },

    settings: {
      inventoryDeductionTrigger: {
        type: String,
        enum: INVENTORY_DEDUCTION_TRIGGERS,
        default: 'on_send_to_kitchen',
      },
      // false = refuse to fire an order line when ingredients are short.
      // Many kitchens set true, since counts are rarely perfect and blocking a sale is worse.
      allowNegativeStock: { type: Boolean, default: false },
      orderNumberPrefix: { type: String, default: 'ORD', maxlength: 10 },
      poNumberPrefix: { type: String, default: 'PO', maxlength: 10 },
    },

    subscription: {
      plan: { type: String, enum: SUBSCRIPTION_PLANS, default: 'free' },
      status: { type: String, enum: SUBSCRIPTION_STATUS, default: 'trialing' },
      trialEndsAt: Date,
      currentPeriodEnd: Date,
    },

    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: TENANT_STATUS, default: 'active' },
  },
  schemaOptions()
);

tenantSchema.plugin(softDeletePlugin);

// Global (not tenant-prefixed) because the slug is how a tenant is found in the first place.
tenantSchema.index({ slug: 1 }, { unique: true });
tenantSchema.index({ ownerId: 1 });
tenantSchema.index({ status: 1, 'subscription.status': 1 }); // platform billing jobs

tenantSchema.virtual('isOperational').get(function isOperational() {
  return this.status === 'active' && !this.isDeleted && this.subscription?.status !== 'cancelled';
});

module.exports = mongoose.model('Tenant', tenantSchema);
