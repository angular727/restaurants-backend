/**
 * Order (POS) workflows. Every step that touches more than one document (order + table,
 * order + stock) runs in a single transaction.
 *
 *   createOrder ──► addItems* ──► sendToKitchen ──► (KDS item status) ──► payments ──► completeOrder
 *        │                              │                                                  │
 *   occupy table            deduct stock (if trigger =                       deduct anything still
 *                           on_send_to_kitchen)                              undeducted, free table
 */
const { Order, MenuItem, Table, Tenant, Counter, TenantMember, InventoryItem } = require('../models');
const { ORDER_SOURCES } = require('../config/enums');
const { badRequest, conflict, notFound } = require('../utils/errors');
const { getTenantId } = require('../utils/tenantContext');
const { withTransaction } = require('../utils/transaction');
const inventoryService = require('./inventory.service');

async function loadTenant(session) {
  const tenant = await Tenant.findById(getTenantId()).session(session).lean();
  if (!tenant) throw notFound('Tenant');
  return tenant;
}

async function loadOrder(orderId, session) {
  const order = await Order.findById(orderId).session(session);
  if (!order) throw notFound('Order');
  return order;
}

/** A waiter must be an active member of the current restaurant. */
async function assertActiveMember(userId, session) {
  const member = await TenantMember.exists({ userId, status: 'active' }).session(session);
  if (!member) throw badRequest('waiterId must be an active member of this restaurant', 'INVALID_WAITER');
}

function assertEditable(order) {
  if (['completed', 'cancelled'].includes(order.status)) {
    throw conflict(`Order ${order.orderNumber} is ${order.status}`, 'ORDER_CLOSED');
  }
}

/**
 * Turn [{ menuItemId, quantity, notes, discountAmount, modifiers }] into order lines with
 * price/tax snapshots. `modifiers`: [{ inventoryItemId, action: 'add'|'remove', quantity?, priceDelta? }],
 * per-portion ingredient customizations that leave the menu recipe itself untouched — see
 * orderItemModifierSchema (models/Order.js) and deductForOrder (services/inventory.service.js).
 * `quantity` is per portion in both directions: for 'add' it's how much extra; for 'remove'
 * it's how much less of a recipe ingredient (0 or unset there behaves as "leave it as-is",
 * and a value at or above the recipe's own amount removes it entirely).
 */
async function buildLines(requested, tenant, userId, session) {
  if (!Array.isArray(requested) || requested.length === 0) throw badRequest('items must be a non-empty array');

  const ids = [...new Set(requested.map((r) => String(r.menuItemId)))];
  const menuItems = await MenuItem.find({ _id: { $in: ids }, isActive: true }).session(session).lean();
  const byId = new Map(menuItems.map((m) => [String(m._id), m]));

  const modIds = [...new Set(requested.flatMap((r) => (r.modifiers || []).map((m) => String(m.inventoryItemId))))];
  const invById = modIds.length
    ? new Map(
        (await InventoryItem.find({ _id: { $in: modIds } }, 'name unit', { withDeleted: true }).session(session).lean()).map((i) => [
          String(i._id),
          i,
        ])
      )
    : new Map();

  return requested.map((r) => {
    const mi = byId.get(String(r.menuItemId));
    if (!mi) throw badRequest(`Menu item ${r.menuItemId} not found or inactive`, 'MENU_ITEM_NOT_FOUND');
    if (!mi.isAvailable) throw conflict(`"${mi.name}" is currently unavailable`, 'MENU_ITEM_UNAVAILABLE');

    const recipeIds = new Set((mi.recipe || []).map((ing) => String(ing.inventoryItemId)));
    const modifiers = (r.modifiers || []).map((m) => {
      const inv = invById.get(String(m.inventoryItemId));
      if (!inv) throw badRequest(`Ingredient ${m.inventoryItemId} not found`, 'INGREDIENT_NOT_FOUND');
      const action = m.action === 'remove' ? 'remove' : 'add';
      if (action === 'remove' && !recipeIds.has(String(m.inventoryItemId))) {
        throw badRequest(`"${inv.name}" is not part of "${mi.name}"'s recipe, so it can't be removed`, 'INVALID_MODIFIER');
      }
      return {
        inventoryItemId: inv._id,
        name: inv.name,
        unit: inv.unit,
        action,
        quantity: Math.max(0, Number(m.quantity) || 0),
        priceDelta: Math.round(Number(m.priceDelta) || 0),
      };
    });

    return {
      menuItemId: mi._id,
      name: mi.name,
      kitchenStation: mi.kitchenStation,
      unitPrice: mi.price,
      taxRate: mi.taxRate ?? tenant.tax.rate,
      quantity: r.quantity ?? 1,
      notes: r.notes,
      discountAmount: r.discountAmount ?? 0,
      modifiers,
      addedBy: userId,
    };
  });
}

/** Atomically claim a table: succeeds only if it's free, so two waiters can't both seat it. */
async function occupyTable(tableId, orderId, session) {
  const table = await Table.findOneAndUpdate(
    { _id: tableId, isActive: true, status: { $in: ['available', 'reserved'] }, currentOrderId: null },
    { $set: { status: 'occupied', currentOrderId: orderId } },
    { new: true, session }
  );
  if (!table) {
    const exists = await Table.exists({ _id: tableId }).session(session);
    if (!exists) throw notFound('Table');
    throw conflict('Table is not available', 'TABLE_NOT_AVAILABLE');
  }
  return table;
}

function releaseTable(order, session) {
  if (!order.tableId) return null;
  return Table.updateOne(
    { _id: order.tableId, currentOrderId: order._id },
    { $set: { status: 'available', currentOrderId: null } },
    { session }
  );
}

// ---------------------------------------------------------------------------------

async function createOrder(input, userId) {
  return withTransaction(async (session) => {
    const tenant = await loadTenant(session);
    const seq = await Counter.next('order', { session });

    const order = new Order({
      orderNumber: Counter.format(tenant.settings.orderNumberPrefix, seq),
      type: input.type,
      source: input.source,
      tableId: input.type === 'dine_in' ? input.tableId : null,
      guestCount: input.guestCount,
      customer: input.customer,
      notes: input.notes,
      currency: tenant.currency,
      pricesIncludeTax: tenant.tax.pricesIncludeTax,
      serviceChargeRate: input.type === 'dine_in' ? tenant.tax.serviceChargeRate : 0,
      createdBy: userId,
    });
    if (input.items?.length) order.items.push(...(await buildLines(input.items, tenant, userId, session)));
    let table = null;
    if (order.type === 'dine_in' && order.tableId) table = await occupyTable(order.tableId, order._id, session);

    // Waiter: explicit choice, else the table's assigned waiter, else whoever entered the order.
    if (input.waiterId) await assertActiveMember(input.waiterId, session);
    order.waiterId = input.waiterId || table?.assignedWaiterId || userId;

    await order.save({ session });
    return order;
  });
}

/** Reassign the waiter serving an open order (e.g. a shift change). */
async function setWaiter(orderId, waiterId) {
  if (!waiterId) throw badRequest('waiterId is required');
  const order = await loadOrder(orderId, null);
  assertEditable(order);
  await assertActiveMember(waiterId, null);
  order.waiterId = waiterId;
  await order.save();
  return order;
}

async function addItems(orderId, items, userId) {
  return withTransaction(async (session) => {
    // Sequential on purpose: operations sharing a transaction's session must not run in parallel.
    const tenant = await loadTenant(session);
    const order = await loadOrder(orderId, session);
    assertEditable(order);
    order.items.push(...(await buildLines(items, tenant, userId, session)));
    await order.save({ session });
    return order;
  });
}

/**
 * Fire all 'pending' lines to the kitchen. With the on_send_to_kitchen trigger (default),
 * this is the moment ingredients leave stock, in the same transaction as the status change.
 * If stock is short and negative stock is not allowed, the whole fire is rolled back.
 */
async function sendToKitchen(orderId, userId) {
  return withTransaction(async (session) => {
    // Sequential on purpose: operations sharing a transaction's session must not run in parallel.
    const tenant = await loadTenant(session);
    const order = await loadOrder(orderId, session);
    assertEditable(order);

    const pending = order.items.filter((l) => l.status === 'pending');
    if (pending.length === 0) throw badRequest('No pending items to send', 'NOTHING_TO_SEND');

    const now = new Date();
    for (const line of pending) {
      line.status = 'sent';
      line.sentAt = now;
    }

    let movements = [];
    if (tenant.settings.inventoryDeductionTrigger === 'on_send_to_kitchen') {
      movements = await inventoryService.deductForOrder(order, {
        session,
        userId,
        allowNegativeStock: tenant.settings.allowNegativeStock,
      });
    }

    if (['open', 'served', 'ready'].includes(order.status)) order.status = 'in_progress';
    order.firstSentAt = order.firstSentAt || now;
    await order.save({ session });
    return { order, movements };
  });
}

/** Kitchen display / waiter updates on a single line. */
async function setItemStatus(orderId, lineId, status) {
  if (!['preparing', 'ready', 'served'].includes(status)) throw badRequest('status must be preparing, ready or served');
  const order = await loadOrder(orderId, null);
  assertEditable(order);
  const line = order.items.id(lineId);
  if (!line) throw notFound('Order line');
  if (['pending', 'cancelled'].includes(line.status)) throw conflict(`Line is ${line.status}`, 'INVALID_LINE_STATE');
  line.status = status;
  if (status === 'served') line.servedAt = new Date();

  // Roll the order status up from its lines.
  const active = order.items.filter((l) => l.status !== 'cancelled');
  if (active.every((l) => l.status === 'served') && order.canTransitionTo('served')) order.status = 'served';
  else if (active.every((l) => ['ready', 'served'].includes(l.status)) && order.canTransitionTo('ready')) order.status = 'ready';

  await order.save();
  return order;
}

/**
 * Cancel one line. `returnToStock`: true if the food was NOT made (ingredients go back),
 * false if it was made and binned (the deduction stands as consumption).
 */
async function cancelItem(orderId, lineId, { reason, returnToStock = true } = {}, userId) {
  return withTransaction(async (session) => {
    const order = await loadOrder(orderId, session);
    assertEditable(order);
    const line = order.items.id(lineId);
    if (!line) throw notFound('Order line');
    if (line.status === 'cancelled') throw conflict('Line already cancelled', 'ALREADY_CANCELLED');

    line.status = 'cancelled';
    line.cancelledAt = new Date();
    line.cancelReason = reason;
    line.cancelledBy = userId;

    if (returnToStock) await inventoryService.returnLinesToStock(order, [line._id], { session, userId, reason });
    await order.save({ session });
    return order;
  });
}

/**
 * Close the bill. Requires full payment. Deducts any lines that were never deducted
 * (always for the on_order_complete trigger, and as a safety net for lines never fired),
 * then frees the table.
 */
async function completeOrder(orderId, userId) {
  return withTransaction(async (session) => {
    // Sequential on purpose: operations sharing a transaction's session must not run in parallel.
    const tenant = await loadTenant(session);
    const order = await loadOrder(orderId, session);
    assertEditable(order);
    if (order.activeItems.length === 0) throw conflict('Cannot complete an order with no items', 'EMPTY_ORDER');
    if (order.balanceDue > 0) {
      throw conflict(`Order has an outstanding balance of ${order.balanceDue}`, 'ORDER_NOT_PAID', {
        balanceDue: order.balanceDue,
      });
    }

    const movements = await inventoryService.deductForOrder(order, {
      session,
      userId,
      allowNegativeStock: tenant.settings.allowNegativeStock,
    });

    const now = new Date();
    for (const line of order.items) {
      if (line.status === 'cancelled') continue;
      if (!line.sentAt) line.sentAt = now;
      if (line.status !== 'served') {
        line.status = 'served';
        line.servedAt = now;
      }
    }
    order.status = 'completed';
    order.completedAt = now;
    await order.save({ session });
    await releaseTable(order, session);
    return { order, movements };
  });
}

async function cancelOrder(orderId, { reason, returnToStock = true } = {}, userId) {
  return withTransaction(async (session) => {
    const order = await loadOrder(orderId, session);
    assertEditable(order);
    if (order.netPaid > 0) {
      throw conflict('Refund all payments before cancelling this order', 'ORDER_HAS_PAYMENTS', { netPaid: order.netPaid });
    }

    const now = new Date();
    for (const line of order.items) {
      if (line.status === 'cancelled') continue;
      line.status = 'cancelled';
      line.cancelledAt = now;
      line.cancelReason = reason;
      line.cancelledBy = userId;
    }
    if (returnToStock) {
      await inventoryService.returnLinesToStock(
        order,
        order.items.map((l) => l._id),
        { session, userId, reason: reason || `Order ${order.orderNumber} cancelled` }
      );
    }

    order.status = 'cancelled';
    order.cancelledAt = now;
    order.cancelReason = reason;
    order.cancelledBy = userId;
    await order.save({ session });
    await releaseTable(order, session);
    return order;
  });
}

/**
 * Set the whole-order discount (minor units; 0 removes it). It is spread over the active lines by
 * Order.recalculateTotals, so it also covers items added later.
 */
async function setDiscount(orderId, amount) {
  if (!Number.isInteger(amount) || amount < 0) throw badRequest('amount must be a non-negative integer in minor units');
  const order = await loadOrder(orderId, null);
  assertEditable(order);

  const previous = order.orderDiscount || 0;
  order.orderDiscount = 0;
  order.recalculateTotals();
  const room = order.subtotal - order.discountTotal;
  if (amount > room) {
    throw badRequest('Discount cannot be more than the order total before this discount', 'DISCOUNT_TOO_LARGE', { max: room });
  }

  order.orderDiscount = amount;
  order.recalculateTotals();
  if (order.netPaid > order.grandTotal) {
    order.orderDiscount = previous;
    throw conflict('The order is already paid more than the discounted total. Refund first.', 'DISCOUNT_BELOW_PAID');
  }
  await order.save();
  return order;
}

/**
 * Update the non-financial details of an open order: guest count, source, notes. Intentionally
 * excludes `type` (dine_in/takeaway/delivery) and `tableId` — changing those means releasing or
 * occupying a table and (for dine_in) a different service charge rate, which is a bigger, riskier
 * operation than this endpoint is meant for.
 */
async function updateDetails(orderId, { guestCount, source, notes } = {}) {
  const order = await loadOrder(orderId, null);
  assertEditable(order);

  if (guestCount !== undefined) {
    const n = Math.round(Number(guestCount));
    if (!Number.isFinite(n) || n < 1 || n > 500) throw badRequest('guestCount must be between 1 and 500');
    order.guestCount = n;
  }
  if (source !== undefined) {
    if (!ORDER_SOURCES.includes(source)) throw badRequest(`source must be one of ${ORDER_SOURCES.join(', ')}`);
    order.source = source;
  }
  if (notes !== undefined) {
    order.notes = String(notes).trim().slice(0, 1000);
  }

  await order.save();
  return order;
}

module.exports = {
  createOrder,
  addItems,
  sendToKitchen,
  setItemStatus,
  cancelItem,
  completeOrder,
  cancelOrder,
  setWaiter,
  setDiscount,
  updateDetails,
};
