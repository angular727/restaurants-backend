/**
 * Seed one demo restaurant, "The Golden Fork", and run a realistic day through the real
 * services, so the data is exactly what the API would produce:
 *
 *   staff → inventory (+ opening balances) → suppliers → menu with recipes → tables
 *   → purchase order (partial + final receipt, weighted-average cost)
 *   → dine-in order fired to the kitchen (stock deducted), paid by card, completed
 *   → takeaway order with one line cancelled (stock returned), paid cash, completed
 *   → ledger reconciliation + tenant-isolation check
 *
 * Re-runnable: wipes only this tenant's data first. Other tenants are untouched.
 *   npm run seed
 */
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db');
const models = require('../models');
const inventoryService = require('../services/inventory.service');
const orderService = require('../services/order.service');
const paymentService = require('../services/payment.service');
const { runWithTenant } = require('../utils/tenantContext');

const {
  Tenant, User, TenantMember, InventoryCategory, InventoryItem, MenuCategory, MenuItem,
  Supplier, PurchaseOrder, Table, Counter, StockMovement,
} = models;

const SLUG = 'golden-fork';
const PASSWORD = 'Password123!';
const money = (n) => `$${(n / 100).toFixed(2)}`;

async function upsertUser(name, email) {
  let user = await User.findOne({ email });
  if (!user) {
    user = new User({ name, email });
    await user.setPassword(PASSWORD);
    await user.save();
  }
  return user;
}

async function wipeTenant(slug) {
  const existing = await Tenant.findOne({ slug }, '_id', { withDeleted: true }).lean();
  if (!existing) return;
  // Raw collection calls on purpose. This is maintenance, and it has to get past the
  // ledger immutability hooks. Always filter by tenantId.
  const scoped = Object.values(models).filter((M) => M.schema.path('tenantId'));
  for (const Model of scoped) await Model.collection.deleteMany({ tenantId: existing._id });
  await Tenant.collection.deleteOne({ _id: existing._id });
  console.log(`[seed] removed previous "${slug}" data`);
}

async function seed() {
  await connectDB();
  await Promise.all(Object.values(models).map((M) => M.init())); // make sure indexes exist
  await wipeTenant(SLUG);

  // ---- Global: users + tenant -----------------------------------------------------
  const owner = await upsertUser('Olivia Owner', 'owner@goldenfork.test');
  const manager = await upsertUser('Marco Manager', 'manager@goldenfork.test');
  const waiter = await upsertUser('Wendy Waiter', 'waiter@goldenfork.test');
  const chef = await upsertUser('Carlos Chef', 'chef@goldenfork.test');
  const cashier = await upsertUser('Casey Cashier', 'cashier@goldenfork.test');

  const tenant = await Tenant.create({
    name: 'The Golden Fork',
    slug: SLUG,
    legalName: 'Golden Fork Hospitality LLC',
    contact: { email: 'hello@goldenfork.test', phone: '+1 212 555 0199' },
    address: { line1: '123 Madison Ave', city: 'New York', state: 'NY', postalCode: '10016', country: 'US' },
    currency: 'USD',
    timezone: 'America/New_York',
    tax: { rate: 8.875, pricesIncludeTax: false, serviceChargeRate: 0 },
    settings: { inventoryDeductionTrigger: 'on_send_to_kitchen', allowNegativeStock: false },
    subscription: { plan: 'pro', status: 'active' },
    ownerId: owner._id,
  });
  console.log(`[seed] tenant ${tenant.name} (${tenant._id})`);

  // ---- Everything below runs inside the tenant context -------------------------------
  // It's the same mechanism the HTTP middleware uses, so tenantId is never passed by hand.
  await runWithTenant({ tenantId: tenant._id, userId: owner._id, role: 'owner' }, async () => {
    // Staff
    const staff = [
      [owner, 'owner'], [manager, 'manager'], [waiter, 'waiter'], [chef, 'chef'], [cashier, 'cashier'],
    ];
    for (const [user, role] of staff) {
      const member = new TenantMember({ userId: user._id, role, status: 'active', displayName: user.name.split(' ')[0] });
      await member.setPin('1234');
      await member.save();
    }

    // Suppliers
    const [produceCo, meatCo, bevCo] = await Supplier.create([
      { name: 'Fresh Farms Produce', code: 'FRESH', email: 'orders@freshfarms.test', paymentTerms: 'net_15', leadTimeDays: 1 },
      { name: 'Prime Meats Co.', code: 'PRIME', email: 'sales@primemeats.test', paymentTerms: 'net_30', leadTimeDays: 2 },
      { name: 'Metro Beverage', code: 'METRO', email: 'hello@metrobev.test', paymentTerms: 'net_30', leadTimeDays: 3 },
    ]);

    // Inventory categories
    const [produce, protein, dairy, dry, beverages] = await InventoryCategory.create([
      { name: 'Produce', sortOrder: 1 },
      { name: 'Meat & Poultry', sortOrder: 2 },
      { name: 'Dairy', sortOrder: 3 },
      { name: 'Dry Goods & Oils', sortOrder: 4 },
      { name: 'Beverages', sortOrder: 5 },
    ]);

    // Inventory items. Stock always starts at 0 (ledger rule). Costs are in cents per BASE unit.
    const itemDefs = [
      // key,        name,                  cat,       unit,  sku,         reorder, supplier,  purchaseUnit,             opening, unitCost
      ['patty',     'Beef Patty 150g',      protein,   'pcs', 'MEAT-PATTY', 40,  meatCo,    { name: 'case', factor: 40 }, 60,    120],
      ['chicken',   'Chicken Breast',       protein,   'g',   'MEAT-CHKN',  3000, meatCo,   { name: 'kg', factor: 1000 }, 8000, 0.9],
      ['bun',       'Brioche Bun',          dry,       'pcs', 'DRY-BUN',    40,  produceCo, { name: 'bag', factor: 12 },  100,   35],
      ['cheddar',   'Cheddar Slice',        dairy,     'pcs', 'DAIRY-CHED', 50,  produceCo, { name: 'pack', factor: 50 }, 200,   25],
      ['parmesan',  'Parmesan',             dairy,     'g',   'DAIRY-PARM', 500, produceCo, { name: 'kg', factor: 1000 }, 1500,  2.5],
      ['lettuce',   'Iceberg Lettuce',      produce,   'g',   'PROD-LETT',  1000, produceCo, { name: 'kg', factor: 1000 }, 3000, 0.4],
      ['romaine',   'Romaine Lettuce',      produce,   'g',   'PROD-ROMA',  1500, produceCo, { name: 'kg', factor: 1000 }, 4000, 0.5],
      ['tomato',    'Tomato',               produce,   'g',   'PROD-TOMA',  1000, produceCo, { name: 'kg', factor: 1000 }, 4000, 0.3],
      ['potato',    'Russet Potato',        produce,   'g',   'PROD-POTA',  5000, produceCo, { name: 'sack', factor: 10000 }, 20000, 0.15],
      ['oil',       'Fryer Oil',            dry,       'ml',  'DRY-OIL',    2000, produceCo, { name: 'jug', factor: 5000 }, 10000, 0.3],
      ['dressing',  'Caesar Dressing',      dry,       'ml',  'DRY-CAES',   1000, produceCo, { name: 'bottle', factor: 1000 }, 3000, 0.8],
      ['croutons',  'Croutons',             dry,       'g',   'DRY-CROU',   500, produceCo, { name: 'bag', factor: 1000 }, 2000, 1],
      ['cola',      'Cola 330ml Can',       beverages, 'pcs', 'BEV-COLA',   24,  bevCo,     { name: 'case', factor: 24 }, 96,    60],
    ];
    const inv = {};
    for (const [key, name, cat, unit, sku, reorderLevel, supplier, purchaseUnit, opening, unitCost] of itemDefs) {
      inv[key] = await InventoryItem.create({
        name, categoryId: cat._id, unit, sku, reorderLevel, reorderQuantity: reorderLevel * 2,
        preferredSupplierId: supplier._id, purchaseUnit, isPerishable: ['Produce', 'Meat & Poultry', 'Dairy'].includes(cat.name),
      });
      await inventoryService.adjustStock(
        { inventoryItemId: inv[key]._id, type: 'opening_balance', quantity: opening, unitCost, reason: 'Initial stock take' },
        owner._id
      );
    }

    // Menu
    const [burgers, salads, sides, drinks] = await MenuCategory.create([
      { name: 'Burgers', sortOrder: 1 },
      { name: 'Salads', sortOrder: 2 },
      { name: 'Sides', sortOrder: 3 },
      { name: 'Drinks', sortOrder: 4 },
    ]);
    const r = (key, quantity, wastagePercent = 0) => ({ inventoryItemId: inv[key]._id, quantity, wastagePercent });

    const [cheeseburger, caesar, fries, cola] = await MenuItem.create([
      {
        categoryId: burgers._id, name: 'Classic Cheeseburger', sku: 'BRG-CLASSIC', price: 1450, kitchenStation: 'grill',
        allergens: ['gluten', 'dairy'], preparationTimeMinutes: 12,
        recipe: [r('patty', 1), r('bun', 1), r('cheddar', 2), r('lettuce', 20), r('tomato', 30, 10)],
      },
      {
        categoryId: salads._id, name: 'Grilled Chicken Caesar', sku: 'SAL-CAESAR', price: 1350, kitchenStation: 'cold',
        allergens: ['gluten', 'dairy', 'eggs', 'fish'], preparationTimeMinutes: 10,
        recipe: [r('chicken', 150), r('romaine', 120, 10), r('parmesan', 20), r('dressing', 40), r('croutons', 25)],
      },
      {
        categoryId: sides._id, name: 'French Fries', sku: 'SID-FRIES', price: 550, kitchenStation: 'fryer',
        dietary: ['vegan', 'gluten_free'], preparationTimeMinutes: 6,
        recipe: [r('potato', 250, 15), r('oil', 30)],
      },
      {
        categoryId: drinks._id, name: 'Cola', sku: 'DRK-COLA', price: 300, kitchenStation: 'bar',
        dietary: ['vegan'], recipe: [r('cola', 1)],
      },
    ]);

    // Tables
    const tables = await Table.create(
      Array.from({ length: 8 }, (_, i) => ({
        name: `T${i + 1}`,
        section: i < 6 ? 'Main' : 'Patio',
        capacity: i % 3 === 0 ? 4 : 2,
        sortOrder: i + 1,
      }))
    );

    // ---- Purchasing: order 5 cases of patties, receive 3 now and 2 later at a new price ----
    const po = await PurchaseOrder.create({
      poNumber: Counter.format('PO', await Counter.next('purchase_order')),
      supplierId: meatCo._id,
      createdBy: manager._id,
      expectedDeliveryDate: new Date(Date.now() + 2 * 864e5),
      items: [
        {
          inventoryItemId: inv.patty._id, itemName: inv.patty.name, baseUnit: 'pcs',
          purchaseUnit: 'case', conversionFactor: 40, quantityOrdered: 5, unitCost: 5200,
        },
      ],
    });
    po.status = 'submitted';
    po.submittedAt = new Date();
    await po.save();

    const lineId = po.items[0]._id;
    await inventoryService.receivePurchaseOrder(po._id, [{ lineId, quantity: 3 }], manager._id);
    const { purchaseOrder: poDone } = await inventoryService.receivePurchaseOrder(
      po._id, [{ lineId, quantity: 2, unitCost: 5400 }], manager._id // supplier raised the price
    );
    const pattyAfterPo = await InventoryItem.findById(inv.patty._id);
    console.log(
      `[seed] ${poDone.poNumber} ${poDone.status}: patties now ${pattyAfterPo.currentStock}, ` +
        `avg cost ${pattyAfterPo.averageCost.toFixed(2)}¢ (was 120¢)`
    );

    // ---- Dine-in order: fire → serve → pay by card → complete -----------------------
    const order1 = await orderService.createOrder(
      {
        type: 'dine_in',
        tableId: tables[0]._id,
        guestCount: 2,
        items: [
          { menuItemId: cheeseburger._id, quantity: 2, notes: 'one medium-rare' },
          { menuItemId: caesar._id, quantity: 1 },
          { menuItemId: fries._id, quantity: 2 },
          { menuItemId: cola._id, quantity: 2 },
        ],
      },
      waiter._id
    );
    const { movements } = await orderService.sendToKitchen(order1._id, waiter._id);
    for (const line of order1.items) await orderService.setItemStatus(order1._id, line._id, 'served');
    const fresh1 = await models.Order.findById(order1._id);
    await paymentService.recordPayment(
      order1._id,
      { method: 'card', amount: fresh1.grandTotal, tipAmount: 1000, provider: { name: 'stripe', transactionId: 'pi_demo_001', cardBrand: 'visa', last4: '4242' }, idempotencyKey: 'seed-pay-1' },
      cashier._id
    );
    const { order: done1 } = await orderService.completeOrder(order1._id, cashier._id);
    console.log(
      `[seed] ${done1.orderNumber} (T1) ${done1.status}/${done1.paymentStatus}: subtotal ${money(done1.subtotal)}, ` +
        `tax ${money(done1.taxTotal)}, total ${money(done1.grandTotal)}, tip ${money(done1.tipTotal)}, ` +
        `${movements.length} stock movements`
    );

    // ---- Takeaway: fire, cancel the fries (not cooked, so return to stock), pay cash --
    const order2 = await orderService.createOrder(
      { type: 'takeaway', customer: { name: 'Pat' }, items: [{ menuItemId: cheeseburger._id }, { menuItemId: fries._id }] },
      cashier._id
    );
    await orderService.sendToKitchen(order2._id, cashier._id);
    const friesLine = order2.items.find((l) => l.name === 'French Fries');
    const afterCancel = await orderService.cancelItem(
      order2._id, friesLine._id, { reason: 'Customer changed mind', returnToStock: true }, manager._id
    );
    await paymentService.recordPayment(order2._id, { method: 'cash', amount: afterCancel.grandTotal, cashTendered: 2000 }, cashier._id);
    const { order: done2 } = await orderService.completeOrder(order2._id, cashier._id);
    console.log(`[seed] ${done2.orderNumber} (takeaway) ${done2.status}/${done2.paymentStatus}: total ${money(done2.grandTotal)}`);

    // ---- Reports -------------------------------------------------------------------
    console.log('\n[seed] Stock levels (ledger check):');
    for (const item of await InventoryItem.find().sort({ name: 1 })) {
      const rec = await inventoryService.reconcileItem(item._id);
      console.log(
        `  ${item.name.padEnd(24)} ${String(item.currentStock).padStart(8)} ${item.unit.padEnd(4)}` +
          `${item.isLowStock ? ' LOW ' : '     '} value ${money(item.stockValue).padStart(9)}  ledger ${rec.inSync ? 'OK' : 'MISMATCH'}`
      );
    }

    const burgerCost = await cheeseburger.computeFoodCost();
    console.log(`\n[seed] Cheeseburger food cost ${money(burgerCost.cost)} = ${burgerCost.foodCostPercent}% of ${money(cheeseburger.price)}`);
    console.log(`[seed] Stock movements recorded: ${await StockMovement.countDocuments()}`);
  });

  // ---- Isolation guard: a tenant-scoped query with no context must fail closed --------
  try {
    await MenuItem.find();
    console.error('[seed] ✗ unscoped query was NOT blocked');
  } catch (err) {
    console.log(`[seed] ✓ unscoped query blocked (${err.code})`);
  }

  console.log(`\n[seed] Done. Log in as owner@goldenfork.test / ${PASSWORD} and send header X-Tenant-ID: ${tenant._id}`);
}

seed()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDB().then(() => mongoose.connection.close()).catch(() => {}));
