/**
 * Inventory service: the ONLY code allowed to change stock levels.
 *
 * ── THE INVENTORY LEDGER MODEL ───────────────────────────────────────────────────
 *
 *   StockMovement (append-only, source of truth)
 *        │   every change = one signed row: +receipt, −sale, −waste, ±adjustment
 *        ▼
 *   InventoryItem.currentStock (cached running total, for fast reads)
 *
 * applyMovement() does both writes in the caller's transaction:
 *     1. findOneAndUpdate({ _id, [currentStock ≥ qty] }, { $inc: { currentStock: qty } })
 *     2. insert StockMovement { quantity: qty, balanceAfter: <new stock> }
 * The $inc is atomic at the document level, so two POS terminals deducting the same
 * ingredient at the same moment can never lose an update (no read-modify-write race).
 * The optional `currentStock ≥ qty` condition turns "don't go negative" into an atomic
 * check-and-set.
 *
 * ── ORDER → STOCK DEDUCTION FLOW ─────────────────────────────────────────────────
 *
 *   Order line fired (or order completed, depending on Tenant.settings)
 *     └─ for each line not yet deducted:
 *          MenuItem.recipe  ×  line.quantity  ×  (1 + wastage%)
 *            → per-ingredient consumption, stored on the line (inventoryConsumed)
 *     └─ sum consumption per ingredient across lines
 *     └─ applyMovement(type: 'sale_deduction', quantity: −total) for each ingredient
 *     └─ mark lines inventoryDeducted = true
 *   All of it inside ONE transaction together with the order save.
 *
 *   Idempotent: lines already deducted are skipped, so firing extra items later only
 *   deducts the new lines.
 *   Reversible: a cancelled line returns exactly `inventoryConsumed` ('sale_reversal'),
 *   even if the recipe has changed since.
 */
const mongoose = require('mongoose');
const { InventoryItem, StockMovement, MenuItem, PurchaseOrder } = require('../models');
const { AppError, badRequest, conflict, notFound } = require('../utils/errors');
const { roundQty } = require('../utils/helpers');
const { withTransaction } = require('../utils/transaction');
const { INBOUND_MOVEMENTS, OUTBOUND_MOVEMENTS } = require('../config/enums');

const MANUAL_MOVEMENT_TYPES = [
  'adjustment',
  'waste',
  'opening_balance',
  'transfer_in',
  'transfer_out',
  'return_to_supplier',
];

/**
 * Change an item's stock and write the matching ledger row. Must run inside a transaction
 * (pass the session) together with whatever business document caused it.
 */
async function applyMovement(
  { inventoryItemId, type, quantity, unitCost, reference, reason, performedBy, occurredAt, enforceNonNegative = false },
  session = null
) {
  const qty = roundQty(quantity);
  if (!qty) throw badRequest('Movement quantity must be non-zero', 'INVALID_QUANTITY');

  const filter = { _id: inventoryItemId };
  if (enforceNonNegative && qty < 0) filter.currentStock = { $gte: -qty };

  // withDeleted: a soft-deleted ingredient can still be on an open order or PO line,
  // and must still move stock (e.g. a reversal).
  const item = await InventoryItem.findOneAndUpdate(
    filter,
    { $inc: { currentStock: qty } },
    { new: true, session, allowStockWrite: true, withDeleted: true }
  );

  if (!item) {
    const existing = await InventoryItem.findById(inventoryItemId, 'name unit currentStock', { withDeleted: true })
      .session(session)
      .lean();
    if (!existing) throw notFound('Inventory item');
    throw new AppError(409, `Insufficient stock for "${existing.name}"`, 'INSUFFICIENT_STOCK', {
      inventoryItemId: existing._id,
      name: existing.name,
      available: existing.currentStock,
      required: -qty,
      unit: existing.unit,
    });
  }

  const [movement] = await StockMovement.create(
    [
      {
        inventoryItemId: item._id,
        type,
        quantity: qty,
        unit: item.unit,
        unitCost: unitCost ?? item.averageCost,
        balanceAfter: roundQty(item.currentStock),
        reference,
        reason,
        performedBy,
        occurredAt,
      },
    ],
    { session }
  );

  return { item, movement };
}

// ---------------------------------------------------------------------------------
// Manual stock operations (back-office)
// ---------------------------------------------------------------------------------

/**
 * Manual movement: opening balance, waste, adjustment, transfers, return to supplier.
 * Callers pass a positive quantity for directional types, and the sign is applied here.
 * 'adjustment' keeps the sign it was given.
 */
async function adjustStock({ inventoryItemId, type, quantity, reason, unitCost }, userId) {
  if (!MANUAL_MOVEMENT_TYPES.includes(type)) {
    throw badRequest(`type must be one of: ${MANUAL_MOVEMENT_TYPES.join(', ')}`, 'INVALID_MOVEMENT_TYPE');
  }
  let signed = Number(quantity);
  if (!Number.isFinite(signed) || signed === 0) throw badRequest('quantity must be a non-zero number');
  if (INBOUND_MOVEMENTS.includes(type)) signed = Math.abs(signed);
  if (OUTBOUND_MOVEMENTS.includes(type)) signed = -Math.abs(signed);

  return withTransaction(async (session) => {
    // An opening balance with a cost also seeds the item's average cost.
    if (type === 'opening_balance' && unitCost != null) {
      await updateAverageCost(inventoryItemId, signed, Number(unitCost), session);
    }
    return applyMovement(
      {
        inventoryItemId,
        type,
        quantity: signed,
        unitCost: unitCost != null ? Number(unitCost) : undefined,
        reason,
        reference: { kind: 'Manual' },
        performedBy: userId,
        enforceNonNegative: signed < 0,
      },
      session
    );
  });
}

/** Physical stock count: record the variance between counted and expected stock as an adjustment. */
async function recordStockCount({ inventoryItemId, countedQuantity, reason = 'Stock count' }, userId) {
  const counted = Number(countedQuantity);
  if (!Number.isFinite(counted) || counted < 0) throw badRequest('countedQuantity must be ≥ 0');

  return withTransaction(async (session) => {
    const item = await InventoryItem.findById(inventoryItemId, 'currentStock').session(session).lean();
    if (!item) throw notFound('Inventory item');
    const variance = roundQty(counted - item.currentStock);
    if (variance === 0) return { item, movement: null, variance };
    const result = await applyMovement(
      {
        inventoryItemId,
        type: 'adjustment',
        quantity: variance,
        reason,
        reference: { kind: 'StockCount' },
        performedBy: userId,
      },
      session
    );
    return { ...result, variance };
  });
}

// ---------------------------------------------------------------------------------
// Sales: order ↔ stock
// ---------------------------------------------------------------------------------

/**
 * Deduct ingredients for every line of `order` that is not cancelled and not yet
 * deducted. The caller must save `order` in the same session afterwards.
 */
async function deductForOrder(order, { session = null, userId = null, allowNegativeStock = false } = {}) {
  const lines = order.items.filter((l) => !l.inventoryDeducted && l.status !== 'cancelled');
  if (lines.length === 0) return [];

  // withDeleted: a dish removed from the menu after it was ordered must still deduct.
  const menuItems = await MenuItem.find(
    { _id: { $in: [...new Set(lines.map((l) => String(l.menuItemId)))] } },
    'name trackInventory recipe',
    { withDeleted: true }
  )
    .session(session)
    .lean();
  const menuById = new Map(menuItems.map((m) => [String(m._id), m]));

  // 1. Explode recipes into per-line consumption, and total it per ingredient. Per-line
  //    `modifiers` (see orderItemModifierSchema) adjust this WITHOUT touching the menu recipe:
  //    'remove' REDUCES a recipe ingredient's raw per-portion quantity by `quantity` (before
  //    wastage%); reaching 0 or below drops it from this line entirely — so it covers both
  //    "less X" and "no X". 'add' consumes extra of any ingredient (in or out of the recipe,
  //    e.g. "+2 egg"), on top, with no wastage multiplier since it isn't a recipe row.
  const totals = new Map(); // inventoryItemId -> base-unit quantity
  for (const line of lines) {
    const menuItem = menuById.get(String(line.menuItemId));
    const consumption = [];
    if (menuItem?.trackInventory) {
      const reduceRaw = new Map(); // inventoryItemId -> raw units to subtract per portion
      for (const m of line.modifiers || []) {
        if (m.action !== 'remove') continue;
        const key = String(m.inventoryItemId);
        reduceRaw.set(key, (reduceRaw.get(key) || 0) + (m.quantity || 0));
      }
      for (const ing of menuItem.recipe) {
        const key = String(ing.inventoryItemId);
        const rawQty = Math.max(0, ing.quantity - (reduceRaw.get(key) || 0));
        if (rawQty <= 0) continue; // reduced to nothing (or fully removed)
        const qty = roundQty(rawQty * (1 + (ing.wastagePercent || 0) / 100) * line.quantity);
        if (qty <= 0) continue;
        consumption.push({ inventoryItemId: ing.inventoryItemId, quantity: qty });
        totals.set(key, roundQty((totals.get(key) || 0) + qty));
      }
      for (const mod of line.modifiers || []) {
        if (mod.action !== 'add') continue;
        const qty = roundQty((mod.quantity || 0) * line.quantity);
        if (qty <= 0) continue;
        consumption.push({ inventoryItemId: mod.inventoryItemId, quantity: qty });
        const key = String(mod.inventoryItemId);
        totals.set(key, roundQty((totals.get(key) || 0) + qty));
      }
    }
    line.inventoryConsumed = consumption;
    line.inventoryDeducted = true;
  }

  // 2. Pre-flight check so the user sees EVERY shortage at once, not only the first.
  //    applyMovement's conditional $inc still guards against races after this check.
  if (!allowNegativeStock && totals.size > 0) {
    const stock = await InventoryItem.find({ _id: { $in: [...totals.keys()] } }, 'name unit currentStock', {
      withDeleted: true,
    })
      .session(session)
      .lean();
    const shortages = stock
      .filter((s) => s.currentStock < totals.get(String(s._id)))
      .map((s) => ({
        inventoryItemId: s._id,
        name: s.name,
        available: s.currentStock,
        required: totals.get(String(s._id)),
        unit: s.unit,
      }));
    if (shortages.length) {
      throw new AppError(409, 'Insufficient stock to fulfil this order', 'INSUFFICIENT_STOCK', { shortages });
    }
  }

  // 3. Apply movements. Sorted ids = consistent write order across concurrent
  //    transactions, which reduces write-conflict retries.
  const reference = { kind: 'Order', id: order._id, lineIds: lines.map((l) => l._id) };
  const movements = [];
  for (const id of [...totals.keys()].sort()) {
    const { movement } = await applyMovement(
      {
        inventoryItemId: id,
        type: 'sale_deduction',
        quantity: -totals.get(id),
        reference,
        reason: `Order ${order.orderNumber}`,
        performedBy: userId,
        enforceNonNegative: !allowNegativeStock,
      },
      session
    );
    movements.push(movement);
  }
  return movements;
}

/**
 * Put back exactly what the given (deducted, not yet returned) lines consumed.
 * Used when a line or order is cancelled before the food was made. If it was already
 * cooked, don't call this: the deduction stands and is effectively waste.
 */
async function returnLinesToStock(order, lineIds, { session = null, userId = null, reason } = {}) {
  const wanted = new Set(lineIds.map(String));
  const lines = order.items.filter((l) => wanted.has(String(l._id)) && l.inventoryDeducted && !l.inventoryReturned);
  if (lines.length === 0) return [];

  const totals = new Map();
  for (const line of lines) {
    for (const c of line.inventoryConsumed) {
      const key = String(c.inventoryItemId);
      totals.set(key, roundQty((totals.get(key) || 0) + c.quantity));
    }
    line.inventoryReturned = true;
  }

  const reference = { kind: 'Order', id: order._id, lineIds: lines.map((l) => l._id) };
  const movements = [];
  for (const id of [...totals.keys()].sort()) {
    if (!totals.get(id)) continue;
    const { movement } = await applyMovement(
      {
        inventoryItemId: id,
        type: 'sale_reversal',
        quantity: totals.get(id),
        reference,
        reason: reason || `Cancelled on order ${order.orderNumber}`,
        performedBy: userId,
      },
      session
    );
    movements.push(movement);
  }
  return movements;
}

// ---------------------------------------------------------------------------------
// Purchasing: PO receipt → stock in
// ---------------------------------------------------------------------------------

/**
 * Weighted-average cost: blend the cost of stock on hand with the incoming batch.
 *   newAvg = (onHand × oldAvg + inQty × inCost) / (onHand + inQty)
 * Negative on-hand stock is treated as 0 so it can't distort the average.
 */
async function updateAverageCost(inventoryItemId, incomingQty, incomingUnitCost, session) {
  const item = await InventoryItem.findById(inventoryItemId, 'currentStock averageCost', { withDeleted: true })
    .session(session)
    .lean();
  if (!item) throw notFound('Inventory item');
  const onHand = Math.max(item.currentStock, 0);
  const total = onHand + incomingQty;
  const newAvg = total > 0 ? (onHand * item.averageCost + incomingQty * incomingUnitCost) / total : incomingUnitCost;
  await InventoryItem.updateOne(
    { _id: inventoryItemId },
    { $set: { averageCost: roundQty(newAvg), lastPurchaseCost: roundQty(incomingUnitCost) } },
    { session, withDeleted: true }
  );
}

/**
 * Receive goods against a PO (full or partial).
 * receipts: [{ lineId, quantity (purchase units), unitCost? (invoice price override) }]
 */
async function receivePurchaseOrder(purchaseOrderId, receipts, userId) {
  if (!Array.isArray(receipts) || receipts.length === 0) throw badRequest('receipts must be a non-empty array');

  return withTransaction(async (session) => {
    const po = await PurchaseOrder.findById(purchaseOrderId).session(session);
    if (!po) throw notFound('Purchase order');
    if (!['submitted', 'partially_received'].includes(po.status)) {
      throw conflict(`Cannot receive goods on a ${po.status} purchase order`, 'INVALID_PO_STATE');
    }

    const movements = [];
    for (const receipt of receipts) {
      const line = po.items.id(receipt.lineId);
      if (!line) throw badRequest(`Unknown PO line ${receipt.lineId}`, 'UNKNOWN_PO_LINE');
      const qty = Number(receipt.quantity);
      if (!(qty > 0)) throw badRequest('Receipt quantity must be > 0');
      if (roundQty(line.quantityReceived + qty) > line.quantityOrdered) {
        throw badRequest(`Over-receipt on "${line.itemName}": outstanding ${line.quantityOutstanding}`, 'OVER_RECEIPT');
      }

      const costPerPurchaseUnit = receipt.unitCost != null ? Number(receipt.unitCost) : line.unitCost;
      const baseQty = roundQty(qty * line.conversionFactor);
      const costPerBaseUnit = costPerPurchaseUnit / line.conversionFactor;

      // Average cost must be computed BEFORE the stock increases.
      await updateAverageCost(line.inventoryItemId, baseQty, costPerBaseUnit, session);
      const { movement } = await applyMovement(
        {
          inventoryItemId: line.inventoryItemId,
          type: 'purchase_receipt',
          quantity: baseQty,
          unitCost: costPerBaseUnit,
          reference: { kind: 'PurchaseOrder', id: po._id, lineIds: [line._id] },
          reason: `PO ${po.poNumber}`,
          performedBy: userId,
        },
        session
      );
      line.quantityReceived = roundQty(line.quantityReceived + qty);
      movements.push(movement);
    }

    po.status = po.isFullyReceived ? 'received' : 'partially_received';
    if (po.status === 'received') po.receivedAt = new Date();
    await po.save({ session });
    return { purchaseOrder: po, movements };
  });
}

// ---------------------------------------------------------------------------------
// Queries & audit
// ---------------------------------------------------------------------------------

function getLowStockItems() {
  return InventoryItem.find({ isActive: true, $expr: { $lte: ['$currentStock', '$reorderLevel'] } })
    .sort({ name: 1 })
    .lean();
}

/**
 * Recompute an item's balance from the ledger and compare it with the cached currentStock.
 * Run it on a schedule. A mismatch means someone bypassed the service, e.g. with a raw
 * collection write.
 */
async function reconcileItem(inventoryItemId) {
  const item = await InventoryItem.findById(inventoryItemId, 'name currentStock', { withDeleted: true }).lean();
  if (!item) throw notFound('Inventory item');
  const [agg] = await StockMovement.aggregate([
    { $match: { inventoryItemId: new mongoose.Types.ObjectId(String(inventoryItemId)) } },
    { $group: { _id: null, balance: { $sum: '$quantity' }, count: { $sum: 1 } } },
  ]);
  const ledgerBalance = roundQty(agg?.balance || 0);
  return {
    inventoryItemId: item._id,
    name: item.name,
    cachedBalance: roundQty(item.currentStock),
    ledgerBalance,
    movementCount: agg?.count || 0,
    inSync: Math.abs(ledgerBalance - item.currentStock) < 1e-6,
  };
}

module.exports = {
  applyMovement,
  adjustStock,
  recordStockCount,
  deductForOrder,
  returnLinesToStock,
  receivePurchaseOrder,
  getLowStockItems,
  reconcileItem,
  MANUAL_MOVEMENT_TYPES,
};
