/**
 * Every enum used by the schemas lives here so routes, services and front-end
 * validation can share one source of truth.
 */

// ---- Tenancy & users -------------------------------------------------------
const TENANT_STATUS = ['active', 'suspended', 'closed'];
const SUBSCRIPTION_PLANS = ['free', 'starter', 'pro', 'enterprise'];
const SUBSCRIPTION_STATUS = ['trialing', 'active', 'past_due', 'cancelled'];
const USER_STATUS = ['active', 'disabled'];

const MEMBER_ROLES = ['owner', 'admin', 'manager', 'cashier', 'waiter', 'chef', 'inventory_clerk'];
const MEMBER_STATUS = ['invited', 'active', 'suspended'];

// When should selling a menu item consume stock?
//  - on_send_to_kitchen: as soon as the line is fired (most accurate for live stock levels)
//  - on_order_complete:  only when the bill is closed (simpler, but stock lags reality)
const INVENTORY_DEDUCTION_TRIGGERS = ['on_send_to_kitchen', 'on_order_complete'];

// ---- Inventory -------------------------------------------------------------
// Store stock in the smallest practical unit (g, ml, pcs) so quantities stay integral
// and floating-point drift on $inc is avoided.
const UNITS = ['g', 'kg', 'ml', 'l', 'pcs', 'oz', 'lb', 'fl_oz', 'bunch', 'portion'];

const STOCK_MOVEMENT_TYPES = {
  PURCHASE_RECEIPT: 'purchase_receipt', // + goods received against a PO
  SALE_DEDUCTION: 'sale_deduction', //     − recipe consumption for an order
  SALE_REVERSAL: 'sale_reversal', //       + cancelled order line returned to stock
  ADJUSTMENT: 'adjustment', //             ± manual correction / stock count variance
  WASTE: 'waste', //                       − spoilage, breakage, staff meals
  TRANSFER_IN: 'transfer_in', //           + from another location
  TRANSFER_OUT: 'transfer_out', //         − to another location
  OPENING_BALANCE: 'opening_balance', //   + initial stock when an item is created
  RETURN_TO_SUPPLIER: 'return_to_supplier', // − goods sent back
};
const STOCK_MOVEMENT_TYPE_VALUES = Object.values(STOCK_MOVEMENT_TYPES);
const INBOUND_MOVEMENTS = ['purchase_receipt', 'sale_reversal', 'transfer_in', 'opening_balance'];
const OUTBOUND_MOVEMENTS = ['sale_deduction', 'waste', 'transfer_out', 'return_to_supplier'];
// 'adjustment' may be either sign.

const STOCK_REFERENCE_KINDS = ['Order', 'PurchaseOrder', 'StockCount', 'Manual'];

// ---- Menu ------------------------------------------------------------------
const DIETARY_TAGS = ['vegetarian', 'vegan', 'gluten_free', 'dairy_free', 'halal', 'kosher', 'spicy'];
const ALLERGENS = [
  'gluten', 'dairy', 'eggs', 'peanuts', 'tree_nuts', 'soy', 'fish',
  'shellfish', 'sesame', 'mustard', 'celery', 'sulphites', 'lupin', 'molluscs',
];

// ---- Purchasing ------------------------------------------------------------
const PO_STATUS = ['draft', 'submitted', 'partially_received', 'received', 'closed', 'cancelled'];
const PO_TRANSITIONS = {
  draft: ['submitted', 'cancelled'],
  submitted: ['partially_received', 'received', 'cancelled'],
  partially_received: ['partially_received', 'received', 'closed'], // closed = short-shipped, stop waiting
  received: ['closed'],
  closed: [],
  cancelled: [],
};
const SUPPLIER_PAYMENT_TERMS = ['prepaid', 'cod', 'net_7', 'net_15', 'net_30', 'net_60'];

// ---- Floor -----------------------------------------------------------------
const TABLE_STATUS = ['available', 'occupied', 'reserved', 'cleaning', 'out_of_service'];

// ---- Orders & payments -----------------------------------------------------
const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'];
const ORDER_SOURCES = ['pos', 'qr', 'online', 'phone'];
const ORDER_STATUS = ['open', 'in_progress', 'ready', 'served', 'completed', 'cancelled'];
const ORDER_TRANSITIONS = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['ready', 'served', 'completed', 'cancelled'],
  ready: ['served', 'completed', 'cancelled'],
  served: ['in_progress', 'completed'], // back to in_progress when more items are fired
  completed: [],
  cancelled: [],
};
const ORDER_ITEM_STATUS = ['pending', 'sent', 'preparing', 'ready', 'served', 'cancelled'];
const ORDER_PAYMENT_STATUS = ['unpaid', 'partially_paid', 'paid', 'refunded'];

const PAYMENT_METHODS = ['cash', 'card', 'mobile_wallet', 'bank_transfer', 'voucher', 'other'];
const PAYMENT_TYPES = ['payment', 'refund'];
const PAYMENT_STATUS = ['pending', 'completed', 'failed', 'voided'];

module.exports = {
  TENANT_STATUS,
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
  USER_STATUS,
  MEMBER_ROLES,
  MEMBER_STATUS,
  INVENTORY_DEDUCTION_TRIGGERS,
  UNITS,
  STOCK_MOVEMENT_TYPES,
  STOCK_MOVEMENT_TYPE_VALUES,
  INBOUND_MOVEMENTS,
  OUTBOUND_MOVEMENTS,
  STOCK_REFERENCE_KINDS,
  DIETARY_TAGS,
  ALLERGENS,
  PO_STATUS,
  PO_TRANSITIONS,
  SUPPLIER_PAYMENT_TERMS,
  TABLE_STATUS,
  ORDER_TYPES,
  ORDER_SOURCES,
  ORDER_STATUS,
  ORDER_TRANSITIONS,
  ORDER_ITEM_STATUS,
  ORDER_PAYMENT_STATUS,
  PAYMENT_METHODS,
  PAYMENT_TYPES,
  PAYMENT_STATUS,
};
