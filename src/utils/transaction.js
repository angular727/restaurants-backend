const mongoose = require('mongoose');
const env = require('../config/env');

/**
 * Run `fn(session)` inside a MongoDB transaction.
 *
 * Inventory changes always touch two collections (InventoryItem.currentStock and
 * StockMovement), and usually a third (Order or PurchaseOrder). They must commit or
 * fail together, so every such flow runs through this helper.
 *
 * `session.withTransaction` retries automatically on TransientTransactionError, for
 * example a write conflict when two tills deduct the same ingredient at the same moment.
 *
 * With USE_TRANSACTIONS=false (a standalone dev mongod), `fn` receives `null` and runs
 * without atomicity.
 */
async function withTransaction(fn) {
  if (!env.useTransactions) return fn(null);

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { withTransaction };
