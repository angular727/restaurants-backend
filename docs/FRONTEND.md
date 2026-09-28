# Frontend integration guide

Everything a web or mobile client needs to talk to the API.

## Base URL & CORS

| Environment | Base URL |
|---|---|
| Local Docker / `npm run dev` | `http://localhost:4000/api/v1` |
| Production | `https://<your-api-domain>/api/v1` |

Your frontend's origin must be listed in `CORS_ORIGINS` (in `.env.production` or `.env`), with the exact
scheme, host and port, e.g. `http://localhost:5173`. In development with no `CORS_ORIGINS` set, any origin is allowed.
After changing it, restart the API with `docker compose up -d`.

## Authentication flow

```
1. POST /auth/login  { email, password }        → { token, user }
2. GET  /auth/me     (Bearer token)             → { user, restaurants: [{ tenantId, name, slug, role }] }
3. User picks a restaurant (skip if only one)   → remember tenantId
4. Every other request sends BOTH headers:
      Authorization: Bearer <token>
      X-Tenant-ID:   <tenantId>
```

- The token lasts `JWT_EXPIRES_IN` (12h by default). On a `401` response, send the user back to login.
- The token is not tied to a restaurant. Switching restaurants only means changing `X-Tenant-ID`.
- The user's `role` from `/auth/me` tells you which screens to show: `owner`, `admin`, `manager`, `cashier`, `waiter`, `chef` or `inventory_clerk`.
  The server enforces roles anyway, and a forbidden action returns `403`.
- A new restaurant signs up with `POST /auth/register { name, email, password, restaurant: { name, slug, currency?, timezone? } }`, which returns `{ token, user, tenant }`.

Minimal fetch wrapper:

```js
const API = import.meta.env.VITE_API_URL; // e.g. http://localhost:4000/api/v1

export async function api(path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth.token && { Authorization: `Bearer ${auth.token}` }),
      ...(auth.tenantId && { 'X-Tenant-ID': auth.tenantId }),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error.message), json.error, { status: res.status });
  return json;
}
```

## Response format

Success:

```json
{ "data": { ... } }                                        // single item
{ "data": [ ... ], "meta": { "page": 1, "limit": 20, "total": 57 } }   // lists
```

Error (always this shape):

```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "Insufficient stock to fulfil this order",
             "details": { "shortages": [ { "name": "Russet Potato", "available": 120, "required": 575, "unit": "g" } ] },
             "requestId": "62291371-7c44-..." } }
```

Show `message` to the user, and branch on `code` in your code. Include `requestId` in bug reports, because it matches the server log line.

| HTTP | Common `code`s | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` (details = `[{path, message}]`), `INVALID_ID`, `BAD_REQUEST`, `NOTHING_TO_SEND` | Fix the input |
| 401 | `UNAUTHORIZED` | Log in again |
| 403 | `FORBIDDEN` | Wrong role, or not a member of this restaurant |
| 404 | `NOT_FOUND` | |
| 409 | `INSUFFICIENT_STOCK`, `TABLE_NOT_AVAILABLE`, `ORDER_NOT_PAID`, `OVERPAYMENT`, `ORDER_CLOSED`, `DUPLICATE` | Business rule blocked the action |
| 429 | `RATE_LIMITED` | Too many requests. Login allows 10 failed attempts per 15 min per IP |

## Conventions

- **IDs**: every object, including order lines and PO lines, has `id`. Use it in URLs (`/orders/:id/items/:lineId/...`).
- **Money is in cents (integers)**: `price: 1450` means $14.50. Display it as `(value / 100).toFixed(2)` or with
  `Intl.NumberFormat(locale, { style: 'currency', currency })`, and send cents back. The currency is `tenant.currency` (`GET /tenant`).
- **Quantities** of stock are in the item's base `unit` (`g`, `ml`, `pcs`, …).
- **Dates** are ISO-8601 UTC strings. Format them in the restaurant's `tenant.timezone`.
- **Pagination**: `?page=1&limit=20` (max 100). Lists also accept simple filters, e.g. `/menu/items?categoryId=…&isActive=true`.
- **Never send** `tenantId`, `currentStock`, totals or statuses you don't own. The server ignores or recomputes them.
- **Deletes** are soft: `DELETE` returns `204`, and the item disappears from lists but stays on old orders.

## Main screens → endpoints

### Menu / POS
```
GET  /menu/categories                      GET /menu/items?isActive=true
POST /menu/items/:id/availability  { isAvailable: false }        // "86" an item
```

### Taking an order
```
GET  /tables                                                     // floor plan: status, currentOrderId
POST /orders  { type: "dine_in", tableId, guestCount,
                items: [{ menuItemId, quantity, notes }] }       // type: dine_in | takeaway | delivery
POST /orders/:id/items  { items: [...] }                         // add more
POST /orders/:id/send                                            // fire to kitchen (deducts stock)
PATCH /orders/:id/items/:lineId/status  { status: "preparing" | "ready" | "served" }   // kitchen display
POST /orders/:id/items/:lineId/cancel   { reason, returnToStock: true }
```
Order fields to display: `orderNumber`, `status`, `items[].status`, `subtotal`, `taxTotal`, `serviceCharge`,
`grandTotal`, `balanceDue`, `paymentStatus`.

### Paying
```
POST /orders/:id/payments  { method: "cash"|"card"|..., amount, tipAmount?, cashTendered? }
     header  Idempotency-Key: <uuid>          // generate once per payment attempt and reuse it on retry
POST /orders/:id/complete                     // needs balanceDue = 0, frees the table
POST /payments/:id/refund  { amount?, reason }
```
For split bills, send several payments. Cash payments return `payment.changeDue`.
Always send an `Idempotency-Key` (`crypto.randomUUID()`), so a retry after a network error never double-charges.

### Inventory & purchasing (back office)
```
GET  /inventory/items           GET /inventory/items/low-stock        GET /inventory/items/:id/movements
POST /inventory/items/:id/adjustments  { type: "waste"|"adjustment"|"opening_balance", quantity, reason }
POST /inventory/items/:id/counts       { countedQuantity }
GET  /suppliers                 POST /purchase-orders  { supplierId, items: [{ inventoryItemId, quantityOrdered, unitCost }] }
POST /purchase-orders/:id/submit        POST /purchase-orders/:id/receive  { receipts: [{ lineId, quantity }] }
GET  /menu/items/:id/food-cost
```

## Status values

All enums (order status, payment method, units, roles, …) are defined in
[`src/config/enums.js`](../src/config/enums.js). Copy them into the frontend or keep them in sync.

Order status: `open → in_progress → ready → served → completed` (or `cancelled`).
Payment status on an order: `unpaid | partially_paid | paid | refunded`.
