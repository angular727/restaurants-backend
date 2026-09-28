/** Copy only whitelisted keys, which stops mass assignment of tenantId, isDeleted, currentStock, etc. */
function pick(source = {}, keys = []) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** Stock quantities are rounded to 4 dp so float math (0.1 + 0.2) doesn't pollute the ledger. */
function roundQty(n) {
  return Math.round(n * 10_000) / 10_000;
}

/** Percentage of an integer minor-unit amount, rounded to the nearest minor unit. */
function percentOf(amountMinor, percent) {
  return Math.round((amountMinor * percent) / 100);
}

function parsePagination(query, { maxLimit = 100, defaultLimit = 20 } = {}) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = { pick, roundQty, percentOf, parsePagination };
