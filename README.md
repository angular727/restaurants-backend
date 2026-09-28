# Restaurant Management System: multi-tenant API (Express + Mongoose)

A multi-tenant SaaS backend for inventory, recipes (BOM), menu, purchasing, tables, POS orders and payments.

## Quick start

```bash
cp .env.example .env          # set MONGO_URI (replica set needed for transactions)
npm install
npm run seed                  # creates "The Golden Fork" demo restaurant and runs a day of orders through it
npm run dev                   # http://localhost:4000
```

A local single-node replica set, if you don't use Atlas:

```bash
mongod --dbpath ./data --replSet rs0 --port 27017
mongosh --eval 'rs.initiate()'
```

Then log in and call any tenant route with the `X-Tenant-ID` header:

```bash
curl -XPOST localhost:4000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"owner@goldenfork.test","password":"Password123!"}'
curl localhost:4000/api/v1/menu/items -H "Authorization: Bearer <token>" -H "X-Tenant-ID: <id printed by seed>"
```

## Run in production (Docker)

```bash
cp .env.production.example .env.production
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # paste as JWT_SECRET
# set CORS_ORIGINS to your frontend URL(s)

docker compose up -d --build                     # MongoDB replica set + API on :4000
docker compose exec api node src/seed/seed.js    # optional: demo restaurant
curl localhost:4000/health
```

| Task | Command |
|---|---|
| Logs | `docker compose logs -f api` |
| Deploy new code | `docker compose up -d --build` (indexes sync automatically on start) |
| Stop / start | `docker compose stop` / `docker compose start` |
| Back up database | `docker compose exec mongo mongodump --archive --gzip > backup-$(date +%F).gz` |
| Restore | `docker compose exec -T mongo mongorestore --archive --gzip --drop < backup.gz` |
| Wipe everything (incl. data!) | `docker compose down -v` |

**Going public on the internet**, in addition to the above:
1. Put HTTPS in front of the API. Use a reverse proxy (Caddy, or nginx + Let's Encrypt), or a platform that provides it
   (Render, Railway, Fly.io). Then set `TRUST_PROXY=1`.
2. Prefer **MongoDB Atlas** for the database (managed backups and auth). Set `MONGO_URI` in `.env.production`
   and remove the `mongo` service. The bundled MongoDB has no password and is only safe because it is unreachable from outside.
3. Set `CORS_ORIGINS` to the real frontend domain.

**Building the frontend?** Read [docs/FRONTEND.md](docs/FRONTEND.md) for the auth flow, headers, response and error format, money units and the endpoints for each screen.

## Folder structure

```
src/
├── app.js / server.js          Express app factory, bootstrap and graceful shutdown
├── config/                     env, db connection, enums (every status/type in one place)
├── models/
│   ├── plugins/                tenantScope (isolation), softDelete
│   ├── schemas/common.js       money/percent fields, tenantRef validator, address
│   └── *.js                    14 models + index.js registry
├── middleware/                 auth (JWT), tenant (resolve + inject), requireRole, errorHandler
├── services/                   inventory (ledger + deduction), order (POS flow), payment
├── routes/                     REST skeleton (+ generic CRUD factory)
├── seed/seed.js                demo restaurant
├── scripts/syncIndexes.js      production index build
└── utils/                      tenantContext (AsyncLocalStorage), transactions, errors, helpers
```

## Key design decisions

### 1. Multi-tenancy: shared collections with a `tenantId` discriminator

Every restaurant-owned document has `tenantId`. Isolation is enforced in layers, so a single forgotten filter can't leak data:

| Layer | Where | What it does |
|---|---|---|
| Resolve | `middleware/tenant.js` | Reads the tenant from `X-Tenant-ID` / `X-Tenant-Slug` / subdomain and checks for an **active TenantMember** row |
| Inject | `utils/tenantContext.js` | Puts the tenant in AsyncLocalStorage for the rest of the request |
| Enforce | `models/plugins/tenantScope.plugin.js` | Adds `tenantId` to every find/update/delete/count/aggregate and fills it in on save. **Fails closed**: a query with no context and no tenantId throws |
| Guard refs | `tenantRef()` in `schemas/common.js` | Rejects a `categoryId` or `supplierId` that belongs to another tenant |
| Whitelist | `routes/crud.js` `fields` | A `tenantId` or `currentStock` in the request body is ignored |

Cross-tenant work (login, "my restaurants", platform jobs) must opt in explicitly with `runAsSystem()`.

`Tenant` and `User` are global. A user can belong to many restaurants through `TenantMember`.

### 2. Embedding vs referencing

| Data | Decision | Why |
|---|---|---|
| OrderItems → Order | **Embedded** | Always read and written with the order. Totals stay atomic with the lines. Bounded size |
| PurchaseOrderItems → PurchaseOrder | **Embedded** | Same lifecycle as the PO. Lines keep `_id` so receipts can reference them |
| RecipeIngredients → MenuItem | **Embedded** | Needed in full every time a dish is fired. 3–30 lines. Recipe edits are atomic. A multikey index answers "which dishes use X?" |
| StockMovements | **Separate collection** | High volume, append-only, queried by time/type/reference, archivable |
| Payments | **Separate collection** | Own lifecycle (gateway callbacks, refunds days later), split bills, audit |
| Everything else | Referenced | Independent entities |

Order lines and PO lines **snapshot** name, price, tax and units, so editing the menu never rewrites past receipts.

### 3. Inventory: ledger + cached balance

- `StockMovement` is the **immutable source of truth**. Hooks block any update or delete. Mistakes are corrected with compensating entries.
- `InventoryItem.currentStock` is a **cache**. Hooks reject any write to it except from `inventory.service#applyMovement`, which does an atomic `$inc` **and** inserts the movement in the same transaction.
- "Don't go negative" is an atomic conditional update: `{ currentStock: { $gte: qty } }`.
- `reconcileItem()` compares the ledger sum with the cache (the seed checks every item).
- Purchase receipts update a **weighted-average cost**, which values stock and costs each sale (COGS).

**Deduction flow** (`inventory.service#deductForOrder`), triggered on *send to kitchen* (or *order complete*, set per tenant):

```
for each line not yet deducted:
    consumption = recipe.quantity × (1 + wastage%) × line.quantity   → saved on the line
sum per ingredient → shortage pre-check (lists ALL shortages)
→ one 'sale_deduction' movement per ingredient → line.inventoryDeducted = true
all in one transaction with the order save
```

It is idempotent, so firing more items later deducts only the new lines. Cancelling a line with `returnToStock` reverses exactly what that line consumed, even if the recipe changed since.

### 4. Other conventions

- **Money** is stored as integers in minor units (cents), with the currency on the Tenant and snapshotted on each Order. Only per-unit ingredient *costs* may be fractional.
- **Soft delete** is used on master data only. Orders, payments and stock movements are never deleted. They are cancelled, voided or reversed instead.
- **Status machines** for Order, PurchaseOrder and Payment are validated in `pre('validate')` hooks, using the status captured in `post('init')`.
- **Indexes**: every compound index on a tenant-scoped model starts with `tenantId`. There are three documented global exceptions: `Tenant.slug`, `TenantMember.userId` (login) and `Table.qrToken` (QR ordering).
- **Human-readable numbers**: `ORD-000042` and `PO-000007` come from per-tenant atomic counters.
- **Payments** accept an `idempotencyKey`, so a retried request is never charged twice.

## API overview

All routes are under `/api/v1`. Everything except `/auth/*` requires `Authorization: Bearer <jwt>` **and** `X-Tenant-ID`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register` (user + restaurant), `POST /auth/login`, `GET /auth/me` |
| Inventory | CRUD `/inventory/categories`, `/inventory/items` · `GET /inventory/items/low-stock` · `GET /inventory/items/:id/movements` · `POST /inventory/items/:id/adjustments` · `POST /inventory/items/:id/counts` · `GET /inventory/items/:id/reconcile` |
| Menu | CRUD `/menu/categories`, `/menu/items` · `GET /menu/items/:id/food-cost` · `POST /menu/items/:id/availability` |
| Purchasing | CRUD `/suppliers` · `GET/POST /purchase-orders` · `POST /purchase-orders/:id/{submit,receive,cancel}` |
| Floor & POS | CRUD `/tables` · `GET/POST /orders` · `POST /orders/:id/{items,send,complete,cancel}` · `PATCH /orders/:id/items/:lineId/status` · `POST /orders/:id/items/:lineId/cancel` |
| Payments | `GET/POST /orders/:id/payments` · `GET /payments` · `POST /payments/:id/refund` |

## Production notes

- Production hardening: helmet headers, CORS allowlist, per-IP rate limits (global + brute-force protection on login),
  gzip, request IDs in logs and error responses, no stack traces in responses, graceful shutdown on SIGTERM,
  crash → exit → auto-restart. The app refuses to start with a weak `JWT_SECRET`.
- Transactions need a replica set. `USE_TRANSACTIONS=false` exists only for a standalone dev `mongod`.
- `autoIndex` is off in production. The Docker entrypoint runs `sync-indexes` before starting. When running several
  API replicas, set `SYNC_INDEXES_ON_START=false` and run it once per deploy.
- Rate limits live in memory, per instance. Use a Redis store when running more than one instance.
- `bulkWrite` and raw `Model.collection.*` calls bypass the tenant plugin, so add `tenantId` to those yourself.
- Tenant membership is checked with 2 indexed reads per request. Cache it (Redis, ~60 s) at scale.
