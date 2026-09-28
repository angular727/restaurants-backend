/**
 * Model registry. Require models from here so every schema (and its hooks) is registered
 * before any `mongoose.model('X')` lookup inside hooks or validators.
 *
 *  Global (no tenantId)           Tenant-scoped (tenantId on every document)
 *  ─────────────────────          ───────────────────────────────────────────────
 *  Tenant                         TenantMember           InventoryCategory
 *  User                           InventoryItem          StockMovement (ledger)
 *                                 MenuCategory           MenuItem (+ embedded recipe)
 *                                 Supplier               PurchaseOrder (+ embedded lines)
 *                                 Table                  Order (+ embedded items)
 *                                 Payment (ledger)       Counter
 */
module.exports = {
  Tenant: require('./Tenant'),
  User: require('./User'),
  TenantMember: require('./TenantMember'),
  InventoryCategory: require('./InventoryCategory'),
  InventoryItem: require('./InventoryItem'),
  StockMovement: require('./StockMovement'),
  MenuCategory: require('./MenuCategory'),
  MenuItem: require('./MenuItem'),
  Supplier: require('./Supplier'),
  PurchaseOrder: require('./PurchaseOrder'),
  Table: require('./Table'),
  Order: require('./Order'),
  Payment: require('./Payment'),
  Counter: require('./Counter'),
};
