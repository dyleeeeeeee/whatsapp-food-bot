# FastChow Operator & QA Guide

This document provides guidance for restaurant operators and quality assurance testing.

## Admin Guide

Admins are the phone numbers in the `AdminUsers` table. Sending **ADMIN** from
one opens the admin panel. Anytime: **ADMIN** returns to the panel, **BACK**
goes back a step, **CANCEL** aborts.

### 🔑 Admins
- **Add an admin:** `node scripts/add-admin.js 2348012345678 "Name"`
  (international format, no `+`). Takes effect within a minute; admin status
  is cached for 60 seconds.
- **List admins:**
  `npx wrangler d1 execute food-bot-db --remote --command="SELECT * FROM AdminUsers;"`
- **Remove an admin:**
  `npx wrangler d1 execute food-bot-db --remote --command="DELETE FROM AdminUsers WHERE phone_number='234...';"`

### 📦 Orders (daily work)
- **New order alert.** When a customer pays, every admin gets the order
  details (customer name and phone, address, notes, items, service fee, total)
  and two buttons: **✅ Confirm** (accepts it and tells the customer) and
  **📦 Order #N** (opens it).
- **Orders list:** Admin panel → **📦 Orders**. Shows paid orders that are not
  yet delivered or cancelled, oldest first. Unpaid orders are hidden; the
  screen says how many and how to clear them. **⌨️ Type Order ID** opens any
  order, paid or not.
- **Updating an order.** Opening an order shows its full details, then only
  the statuses it can move to:
  Confirmed → Preparing → Ready / On its way → Delivered, or Cancelled. After
  each change the customer gets a WhatsApp message, and the admin gets a
  one-tap button for the next step.
  - **Delivered** and **Cancelled** ask for confirmation and are final.
  - **Unpaid orders can only be cancelled.**
  - **Cancelling a paid order refunds it** through Flutterwave automatically.
    Admins get an alert with the result; check the Flutterwave dashboard.

### 🍽️ Menu
- **🔄 In/Out of Stock:** tap an item to flip it between available and
  unavailable. Unavailable items are hidden from customers but keep their
  history.
- **✏️ Edit Item:** change name, price, description, image, availability or
  category.
- **➕ Add Item:** name, category, price, description, image. Uses a WhatsApp
  form (Flow) when `ADD_ITEM_FLOW_ID` is set; otherwise a step-by-step chat.
  The category step can also create a new category.
- **🗑️ Delete Item:** items that appear in past orders can't be deleted. Mark
  them out of stock instead.
- **📂 Categories:** every item per category, with unavailable ones marked.
- **Search:** in In/Out of Stock, Edit, Delete and the bulk item lists, type
  part of an item's name to filter. Send **ALL** to show everything again.

> ⚠️ After adding, renaming or deleting a **category**, the WhatsApp Add-Item
> form's category dropdown is out of date until `flows/add-item.json` is
> updated and re-published in Meta. The bot warns about this. The chat-based
> Add Item always works.

### 🏗️ Bulk Actions
- **Orders:** pick a status, tick orders (all active orders are listed here,
  including unpaid ones), review, then choose whether customers are notified.
  Cancelling asks for a reason shown to the customer. Orders that are already
  in that status, final, or unpaid (for kitchen statuses) are skipped and
  counted. **Use this to clear abandoned unpaid orders:** Cancelled → select →
  No, Silent.
- **Menu items:** paste many items at once, remove several, or edit several
  (availability, set or adjust price by ₦ or %, move category, description,
  image).
- **Categories:** add several, rename, delete (deleting or moving their
  items), or move all items from one category to another.
- Every bulk action is recorded in `BulkActionLogs` with a log ID.

### 💳 Payments (summary)
- Orders are created `unpaid`; the customer gets a Flutterwave payment link.
- An order becomes `paid` through the Flutterwave webhook, the 5-minute
  reconciliation sweep, or the customer checking their order, whichever comes
  first. It happens exactly once, and that is when the customer's receipt and
  the admin alert are sent.
- Details and setup: [FLUTTERWAVE_DEPLOYMENT.md](FLUTTERWAVE_DEPLOYMENT.md).


---

## Database Migrations

Schema changes live in the `migrations/` folder as numbered, forward-only SQL files. The base schema is still `schema.sql` (full provisioning, safe to re-run); each `migrations/000N_*.sql` file carries only the additive changes introduced after it.

- **Files are forward-only and idempotent.** Every statement is `CREATE TABLE/INDEX IF NOT EXISTS` (or `INSERT OR IGNORE`) — nothing alters or drops existing tables/columns. Re-running a migration is a no-op, so it is always safe to re-apply.
- **Apply a migration to production:**
  ```
  wrangler d1 execute food-bot-db --remote --file=migrations/0002_prod_hardening.sql
  ```
  Omit `--remote` to apply against the local dev D1. Apply files in numeric order.
- **Verify the table landed:**
  ```
  wrangler d1 execute food-bot-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name='RefundLog';"
  ```

### `0002_prod_hardening.sql`

Adds the `RefundLog` table (+ `idx_refundlog_order` index) used for best-effort refund/dispute persistence.

**Order placement does NOT depend on this migration.** Idempotency for order creation reuses the existing `payment_reference TEXT UNIQUE` column on `Orders` — no new column or table is on the critical path. `RefundLog` is written only inside `db.logRefund` under try/catch, so if the migration hasn't been applied yet the write degrades gracefully (logs and continues) instead of breaking a flow. This means code can deploy before or after the migration runs, in either order.

> **Note:** There is no automatic migration runner or applied-version tracking table — migrations are applied manually and ordering is by filename. Keep new files strictly additive/idempotent so re-running the whole folder stays safe.
>
> `migration_001.sql` and `migration_002.sql` in the repo root are historical and already part of `schema.sql`; don't re-run them. Always pass `--remote` for production — without it Wrangler v3 targets the **local** database and appears to succeed.

---

## Runbook

Common production incidents and how to resolve them.

### Webhook secret mismatch (401 in logs)
**Symptom:** `/flutterwave/webhook` returns `401` in the Worker logs (`wrangler tail`); payments never auto-confirm to `paid`.

**Cause:** The `verif-hash` header sent by Flutterwave does not match the `FLUTTERWAVE_WEBHOOK_SECRET` Worker secret (or the secret is unset — an unset secret always 401s).

**Fix:**
1. Confirm the secret exists: `wrangler secret list` (look for `FLUTTERWAVE_WEBHOOK_SECRET`).
2. Re-set it if needed: `wrangler secret put FLUTTERWAVE_WEBHOOK_SECRET`.
3. In the Flutterwave dashboard, set the webhook **Secret hash** to the EXACT same value (no trailing whitespace).
4. Webhook URL must be `https://<your-worker-domain>/flutterwave/webhook` with the `charge.completed` event enabled.
5. Any payments missed while the secret was wrong are recovered automatically by the reconciliation cron (below) — no manual replay needed.

### WhatsApp Flow not published (`#131009`)
**Symptom:** Sending a Flow message fails with WhatsApp error code `131009` ("Parameter value is not valid") and the interactive Flow never renders for the customer.

**Cause:** The Flow referenced by the worker is in `DRAFT` and not `PUBLISHED`, or the `flow_id` / `flow_token` no longer matches the published Flow.

**Fix:**
1. Open WhatsApp Manager → Flows and confirm the Flow status is **Published** (not Draft).
2. Re-publish if it reverted to draft after an edit.
3. Verify the `flow_id` configured in the worker matches the published Flow's ID.
4. Re-test by triggering the flow from a test number; watch `wrangler tail` for the error to clear.

### KV / D1 outage
**Symptom:** Reads/writes to session state (KV) or orders/menu (D1) intermittently fail; bot replies stall or error.

**Behavior:** KV is used for transient session state and the menu cache; D1 holds orders. `markOrderPaidAtomic` is the single atomic chokepoint for paid-transitions, so a partial outage cannot double-confirm an order.

**Fix:**
1. Check Cloudflare status (https://www.cloudflarestatus.com) for KV/D1 incidents.
2. During a KV outage, session state may reset mid-conversation — customers can restart by sending "Hi". The menu cache misses fall through to D1.
3. During a D1 outage, order placement and admin actions will fail; do not retry writes blindly. Once D1 recovers, the reconciliation cron settles any payments that completed during the gap.
4. If an outage caused stuck `pending` payments, let the cron run (or trigger a manual sweep) rather than hand-editing rows.

### Reconciliation cron
**What it does:** A scheduled sweep (`reconcilePendingPayments`) catches payments that completed at Flutterwave but whose webhook never landed (e.g. webhook-secret mismatch or a KV/D1 blip).

- It selects recent `payment_status='pending'` orders with a `payment_reference`, re-verifies each against Flutterwave, and confirms (via `markOrderPaidAtomic`) only when status is `successful`, currency is `NGN`, and the amount matches the order total.
- Stale `pending` orders older than ~1 day with no successful transaction are aged out to `failed`.
- It never throws (per-order try/catch). On amount mismatches or systemic failures it alerts every admin in `AdminUsers`, plus `ADMIN_ALERT_PHONE` if set, at most once an hour per issue.
- When it confirms a payment, the customer gets the receipt and every admin gets the new-order alert, the same as via the webhook.

**If payments are not auto-confirming:** first fix the webhook secret (above); the cron is the safety net, not the primary path. Check `wrangler tail` for cron invocation logs and any `alertAdmin` messages.

### Backups / DR
- **D1 Time Travel (30 days):** D1 keeps a 30-day continuous backup. Restore to a point in time (or inspect a bookmark) with:
  ```
  wrangler d1 time-travel restore food-bot-db --timestamp="2026-06-27T12:00:00Z"
  wrangler d1 time-travel info food-bot-db
  ```
  Use this for accidental deletes or bad bulk actions within the 30-day window.
- **Recommended off-platform backup:** schedule a periodic `wrangler d1 export` and push the dump to R2 for retention beyond 30 days and for an off-D1 copy:
  ```
  wrangler d1 export food-bot-db --remote --output=backup-$(date +%F).sql
  # then upload to R2:
  wrangler r2 object put food-bot-backups/backup-$(date +%F).sql --file=backup-$(date +%F).sql
  ```
  Run this on a cron (e.g. daily) so there is always a recent, downloadable snapshot independent of Time Travel's retention window.

---

## Manual QA Script (User Personas)

### 👤 Persona: The Hungry Student (First-time user)
1. Send "Hi" to the bot.
2. Verify welcome message and categories list.
3. Select a category (e.g., Burgers).
4. Select an item (e.g., Cheese Burger).
5. Verify item details show up with image (if available), with prices in ₦ (Naira).
6. Tap "🔢 Choose Qty" (tapping "➕ Add 1" instead would add a single unit immediately).
7. Enter quantity "2".
8. Verify redirected to "My Cart" (state `cart_review`). Note: the bot does NOT ask for item notes during the add flow — per-item notes are only edited later via Manage.
9. Tap "✅ Checkout".
10. Enter address "University Hall, Room 302".
11. Enter delivery notes "Leave at front desk" (this is the `checkout_delivery_notes` step).
12. Verify Order Summary shows everything correctly (items, address, notes, total in ₦).
13. Tap "Place Order".
14. Verify success message with Order ID and a Flutterwave payment link.

### 👤 Persona: The Busy Parent (Editing & Recovery)
1. Add 3 different items to the cart.
2. Go to "My Cart".
3. Tap "✏️ Manage".
4. Select the first item.
5. Tap "Remove" and verify it's gone from the cart.
6. Select the second item.
7. Tap "🔢 Change Qty" and enter "5".
8. Verify quantity updated in cart summary.
9. Tap "✅ Checkout".
10. Enter a short address (e.g., "Main").
11. Verify error message asking for at least 5 characters.
12. Enter full address.
13. On the next step (delivery notes), type "BACK".
14. Verify returned to the address prompt.
15. Send "CANCEL" during checkout.
16. Verify confirmation prompt "Are you sure you want to cancel your current order? This will clear your cart.".
17. Tap "No, Keep it" and verify returned to the cart (cart untouched).

### 👤 Persona: The Order Tracker
1. Send "ORDERS" to the bot.
2. Select an active order from the list.
3. Verify detailed view shows status, items, address, and timestamp.
4. Verify the "⬅️ Order History" button returns to the order list.

### 👤 Persona: The Restaurant Manager (Admin)
1. Place and pay for a small order as a customer (or from an admin number via 👤 User Mode).
2. Verify every admin receives "🔔 New paid order!" with name, address, items, service fee and total, plus **✅ Confirm** and **📦 Order #N** buttons.
3. Tap **✅ Confirm**. Verify the customer gets "Order #N confirmed" and the admin gets a **👨‍🍳 Preparing** button.
4. Tap through Preparing → Ready → Delivered (Delivered asks for confirmation).
5. Tap the old **✅ Confirm** button again. Verify "already …, no change made" and that the customer is not messaged again.
6. Send "ADMIN" → **📦 Orders**. Verify only paid, unfinished orders are listed, with a note on how many unpaid orders are hidden.
7. Open an unpaid order via **⌨️ Type Order ID**. Verify only **Cancelled** is offered.
8. **🔄 In/Out of Stock** → type "rice". Verify only matching items are listed; send "ALL" to see everything.
9. Try to delete an item that appears in past orders. Verify the bot refuses and suggests marking it out of stock.
