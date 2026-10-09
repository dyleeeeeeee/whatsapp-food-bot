# FastChow — WhatsApp Food Ordering Bot

Customers order food by chatting with a WhatsApp number; admins run the menu
and the order queue from the same chat. It runs as a single Cloudflare Worker
with a D1 (SQLite) database, KV for sessions, and Flutterwave for payments in
Naira (₦).

**New to the project? Read in this order:**

1. This README — what it is, how it fits together, how to run, test and deploy.
2. [HANDOVER.md](HANDOVER.md) — the live system: accounts, IDs, secrets, known issues.
3. [DOCS.md](DOCS.md) — operating it day to day: admin guide, runbook, migrations, QA scripts.
4. [FLUTTERWAVE_DEPLOYMENT.md](FLUTTERWAVE_DEPLOYMENT.md) — payment setup and how payment confirmation works.

---

## How it works

```
 Customer / admin on WhatsApp
            │  (Meta webhook, signed)
            ▼
   POST /webhook ──► src/webhook.js ──┬─► handlers/user.js   (customers)
                                      └─► handlers/admin.js  (numbers in AdminUsers)
            │                                   │
            │                                   ├─► D1: menu, orders, admins, logs
            │                                   ├─► KV: sessions, carts, caches
            │                                   └─► WhatsApp Cloud API (replies)
            ▼
   Checkout ──► Flutterwave payment link
                      │
   POST /flutterwave/webhook ─┐
   cron every 5 min (reconcile)├─► order marked PAID (once) ──► customer receipt
   customer checks their order ┘                             └─► alert to every admin
```

- **One Worker, two entry points.** `fetch()` serves the HTTP routes below;
  `scheduled()` runs the payment reconciliation sweep every 5 minutes.
- **Replies are sent, not returned.** The webhook answers Meta with 200
  straight away and processes the message in `ctx.waitUntil`. Each message is
  de-duplicated by its WhatsApp ID, so Meta's retries never double-process.
- **Conversations are state machines.** Each phone number has a session in KV
  (`session.state`, e.g. `cart_review`, `admin_update_status_value`). Handlers
  switch on the state; global words like `MENU`, `CART`, `CANCEL`, `BACK` and
  `ADMIN` work from any state.
- **An order becomes real when it is paid.** There is no cash on delivery.
  Three paths can mark an order paid (Flutterwave webhook, the 5-minute sweep,
  or the customer checking their order). All go through one atomic update, so
  the receipt and the admin alert fire exactly once.

### HTTP routes

| Route | Purpose |
|---|---|
| `GET /webhook` | Meta webhook verification (checks `VERIFY_TOKEN`). |
| `POST /webhook` | Incoming WhatsApp messages. Signature-checked with `WHATSAPP_APP_SECRET`; 64 KB body cap. |
| `POST /flutterwave/webhook` | Flutterwave `charge.completed` events. Checked against `FLUTTERWAVE_WEBHOOK_SECRET`. |
| `GET /health` | Liveness, no I/O. `?deep=1` also touches D1 and KV. |
| `GET /stats` | Order stats as JSON, needs `Authorization: Bearer <ADMIN_API_KEY>`. Returns 404 while `ADMIN_API_KEY` is unset (currently unset). |

### Repository layout

```
src/
  index.js                    HTTP router + cron entry point
  webhook.js                  Parse Meta payloads, dedupe, route to user/admin handler
  handlers/user.js            Customer flows: menu, cart, checkout, order tracking
  handlers/admin.js           Admin flows: orders, menu editing, bulk actions, alerts
  db.js                       Every D1 query lives here
  session.js                  KV sessions + cart, price formatting/parsing
  whatsapp.js                 WhatsApp Cloud API senders (text, buttons, lists, flows)
  security.js                 Webhook signature check, admin lookup, input sanitising
  reconcile.js                5-minute sweep: confirm missed payments, expire stale ones
  payments/flutterwave.js     Flutterwave API: create payment, verify, refund
  webhooks/flutterwave_handler.js   Flutterwave webhook processing
  lib/alert.js                Best-effort WhatsApp alerts to every admin
  lib/http.js                 fetch with retry/backoff
flows/                        WhatsApp Flow definitions (checkout, admin add-item)
scripts/                      One-off setup helpers (admins, phone registration, profile)
tests/                        node:test suite, no network (fetch, D1 and KV are mocked)
schema.sql                    Full database schema; safe to re-run
migrations/                   Forward-only additions made after schema.sql
migration_001.sql, migration_002.sql   Historical; already folded into schema.sql
seed_menu.sql                 Sample menu for a fresh database
```

### Data

**D1 tables** (see `schema.sql`): `MenuCategories`, `MenuItems`, `Orders`,
`OrderItems`, `AdminUsers`, `BulkActionLogs`, `RefundLog`.

- Order `status`: `pending → confirmed → preparing → ready → delivered`, or
  `cancelled`. `delivered` and `cancelled` are final.
- Order `payment_status`: `unpaid | pending | paid | failed`. A pending payment
  older than a day is marked `failed` by the sweep.
- `payment_reference` is the Flutterwave `tx_ref` and is `UNIQUE`, which is
  what stops a double-tapped "Place Order" from creating two orders.
- `payment_access_code` holds the Flutterwave **transaction id** once paid
  (used for refunds), despite its name.

**KV keys** (binding `SESSION_KV`):

| Key | TTL | Holds |
|---|---|---|
| `session:{phone}` | 2 h | Conversation state |
| `cart:{phone}` | 2 h | Cart (kept apart from the session so a stale read can't wipe it) |
| `addr:{phone}` / `name:{phone}` | 30 days | Last delivery address / WhatsApp profile name |
| `menu:cache` | `MENU_CACHE_TTL` (300 s) | Serialised menu |
| `admin:{phone}` | 60 s | Cached "is this number an admin" |
| `dedup:{wamid}` | 1 h | Message already processed |
| `placing:{phone}` | 60 s | Lock against double "Place Order" taps |
| `bulksel:{phone}` | 1 h | Admin bulk-action selection |
| `alertsent:*`, `alert:*` | 1 h / 7 days | Admin alert de-duplication and audit |
| `flow:stale` | 30 days | Set when categories change and the Add-Item Flow needs re-publishing |

---

## Local development

Requirements: Node 20+ (CI uses 20), npm, and a Cloudflare account for anything
that touches real resources.

```bash
npm ci
npm test                      # full suite, no network or credentials needed
cp .dev.vars.example .dev.vars   # then fill in values for `wrangler dev`
npm run db:migrate:local      # create the local D1 schema
npm run dev                   # wrangler dev --local on http://localhost:8787
```

`.dev.vars` is git-ignored. Set `ENVIRONMENT="development"` in it to skip the
WhatsApp signature check locally, but only when `WHATSAPP_APP_SECRET` is
unset. To talk to the bot from a real phone, Meta must reach your machine
(e.g. a tunnel to port 8787 registered as the webhook URL on a test app).
Don't point the production app at a dev machine.

### Tests

`npm test` runs `node --test tests/*.test.mjs`. Tests drive the real handlers
with a stubbed `fetch` (WhatsApp and Flutterwave calls are recorded, never
sent) and in-memory D1/KV fakes (`tests/helpers.mjs`, or a small fake inside
the test file). When a handler starts issuing a new SQL statement, the fake
must learn it, or the test fails with `unhandled SQL`, which is deliberate.

---

## Deploying

**Normal path: push to `main`.** GitHub Actions (`.github/workflows/ci.yml`)
runs the tests and a dry-run build on every push. On `main` it then runs
`wrangler deploy` using the `CLOUDFLARE_API_TOKEN` repository secret. A failing
test blocks the deploy.

**Manual deploy** (needs a token with Workers Scripts, Workers KV and D1 edit
permissions on the account):

```bash
CLOUDFLARE_API_TOKEN=... npm run deploy   # runs the tests first
npx wrangler deployments list             # confirm the new version is live
npx wrangler tail                         # live logs
```

`wrangler login` does not work from a headless server: the OAuth callback
needs a local browser, and Cloudflare challenges logins from datacenter IPs.
Use an API token there.

**Database changes** are not applied by deploys. See *Database Migrations* in
[DOCS.md](DOCS.md). New tables or columns must be additive, and code that
needs them must not break if they don't exist yet.

---

## Configuration

Secrets are set with `npx wrangler secret put NAME`. Plain variables live in
`wrangler.toml` under `[vars]`.

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `WHATSAPP_TOKEN` | secret | ✅ | Meta Graph API token (permanent System User token in production). |
| `PHONE_NUMBER_ID` | secret | ✅ | The WhatsApp number the bot sends from. |
| `VERIFY_TOKEN` | secret | ✅ | Any string; must match the Meta webhook settings. |
| `WHATSAPP_APP_SECRET` | secret | ✅ | Meta App Secret; every incoming webhook is rejected without it. |
| `FLUTTERWAVE_SECRET_KEY` | secret | ✅ | Flutterwave v3 secret key (`FLWSECK...`). |
| `FLUTTERWAVE_WEBHOOK_SECRET` | secret | ✅ | Must equal the Flutterwave webhook "Secret hash"; webhooks get 401 without it. |
| `ADMIN_API_KEY` | secret | ❌ | Enables `GET /stats`. Unset means the route returns 404. |
| `ADMIN_ALERT_PHONE` | var | ❌ | Extra number for payment alerts, on top of every admin. |
| `ORDER_STATUS_TEMPLATE` | var | ❌ | Approved WhatsApp template for order-status messages (lets them reach customers outside the 24-hour window). Body params: order id, status. |
| `ORDER_STATUS_TEMPLATE_LANG` | var | ❌ | Template language, default `en`. |
| `CHECKOUT_FLOW_ID` | var | ❌ | Customer checkout uses the WhatsApp Flow in `flows/checkout.json`. **Set in production.** |
| `CHECKOUT_FLOW_SCREEN_ID` | var | ❌ | First screen of that Flow, default `CHECKOUT`. |
| `ADD_ITEM_FLOW_ID` | var | ❌ | Admin "Add Item" uses the Flow in `flows/add-item.json`. **Set in production.** |
| `ADD_ITEM_FLOW_SCREEN` | var | ❌ | First screen of that Flow, default `ADD_ITEM`. |
| `FLUTTERWAVE_CALLBACK_URL` | var | ❌ | Where Flutterwave sends the customer after paying. |
| `GRAPH_API_VERSION` | var | ❌ | Graph API version, default `v21.0`. |
| `MENU_CACHE_TTL` | var | ❌ | Menu cache lifetime in seconds, default 300. |
| `ENVIRONMENT` | var | ❌ | `production` / `staging` / `development`. |

Prices are in Naira everywhere and stored as `REAL`; totals are computed in
integer kobo on the server, never trusted from the client. There is no
`FLUTTERWAVE_PUBLIC_KEY` in the code; checkout is server-side only.

---

## Setting up a new instance from scratch

Only needed for a second deployment (e.g. a real staging environment). The live
instance already exists; its details are in [HANDOVER.md](HANDOVER.md).

1. **Cloudflare resources**
   ```bash
   npx wrangler kv namespace create SESSION_KV
   npx wrangler d1 create food-bot-db
   ```
   Put the IDs in `wrangler.toml`, then `npm run db:migrate:prod`
   (optionally followed by `seed_menu.sql`).
2. **Meta / WhatsApp:** create a Business app with the WhatsApp product. Note
   the Phone Number ID and WhatsApp Business Account (WABA) ID. Then:
   `node scripts/register-phone.js <PHONE_NUMBER_ID> <TOKEN> <PIN>` (if the
   number shows as pending), and
   `node scripts/subscribe-waba.js <WABA_ID> <TOKEN>` (required, or no
   messages arrive).
3. **Secrets:** set every ✅ row in the table above.
4. **Deploy:** `npm run deploy`.
5. **Webhooks:** in Meta → WhatsApp → Configuration, set the URL to
   `https://<worker>/webhook` with your `VERIFY_TOKEN`, and subscribe to
   `messages`. In Flutterwave → Settings → Webhooks, set the URL to
   `https://<worker>/flutterwave/webhook`, the Secret hash to
   `FLUTTERWAVE_WEBHOOK_SECRET`, and the event to `charge.completed`.
6. **Admins:** `node scripts/add-admin.js 2348012345678 "Name"`. Numbers use
   international format without `+`.
7. **Optional:** `node scripts/configure-profile.js` sets WhatsApp ice
   breakers and `/` commands. To use the WhatsApp Flows, publish
   `flows/*.json` in Meta's Flow Builder and set the Flow IDs.
8. **Smoke test:** message the number ("Hi") and expect the menu. From an
   admin number, send `ADMIN` and expect the admin panel.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Meta webhook verification fails | `VERIFY_TOKEN` doesn't match the Meta dashboard. |
| Every `POST /webhook` returns 403 | `WHATSAPP_APP_SECRET` missing or wrong. |
| Bot receives nothing | WABA not subscribed (`scripts/subscribe-waba.js`), or webhook not subscribed to `messages`. |
| Payments never confirm, 401s on `/flutterwave/webhook` | `FLUTTERWAVE_WEBHOOK_SECRET` doesn't match the Flutterwave Secret hash. The sweep confirms them within 5 minutes once fixed. |
| Admin or customer doesn't get a message, but logs show 200 | WhatsApp's 24-hour rule: free-form messages only reach people who messaged the bot in the last 24 hours. Use approved templates. |
| Menu changes don't show | Cache is busted on every admin edit; to force it: `npx wrangler kv key delete menu:cache --binding SESSION_KV --remote`. |
| `D1_ERROR: no such table` | Schema or a migration wasn't applied to production (`--remote`). |
| CI deploy fails with "No access" or `/memberships` errors | `CLOUDFLARE_API_TOKEN` secret lacks permissions, or `account_id` is missing from `wrangler.toml`. |
