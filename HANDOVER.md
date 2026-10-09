# Handover — FastChow WhatsApp Bot

State of the live system as of **9 October 2026**. Read [README.md](README.md)
first for how the code works; this file is about the running instance and what
to look out for.

---

## 1. Live system at a glance

| Thing | Value |
|---|---|
| Business name on WhatsApp | **Fastchow**, +234 802 344 8791 |
| WhatsApp Phone Number ID | `1142604728928725` (not secret) |
| Worker | `whatsapp-food-bot` → https://whatsapp-food-bot.oyinxdoubx.workers.dev |
| Cloudflare account ID | `ce6ba1de4efa7a193f9ac480e0774ddc` |
| D1 database | `food-bot-db` (`0bcc31a6-ed24-4874-8cd8-ddf800c3e825`) |
| KV namespace | `SESSION_KV` (`023f47a2c967435a930ce36e15473282`) |
| Cron | every 5 minutes (payment reconciliation) |
| Code | GitHub `dyleeeeeeee/whatsapp-food-bot`, branch `main` |
| Deploys | Automatic on push to `main` (GitHub Actions → `wrangler deploy`) |
| WhatsApp Flows in use | Checkout `989465703956996`, admin Add-Item `1577064570804706` |
| Data size (29 Sept 2026) | 3 categories (IDs 8, 9, 10), 100 menu items, 22 orders, 3 admins |

Logs: Cloudflare dashboard → Workers → `whatsapp-food-bot` → Logs
(observability is on), or `npx wrangler tail`.

---

## 2. Accounts and access to transfer

Each of these is a separate login. The new developer needs access to all of
them, and the outgoing developer's access should be removed afterwards.

| Service | What lives there | Transfer by |
|---|---|---|
| **GitHub** — repo `dyleeeeeeee/whatsapp-food-bot` | Code, CI, the `CLOUDFLARE_API_TOKEN` Actions secret | Transfer the repo or add a collaborator with admin rights (needed to edit Actions secrets). |
| **Cloudflare** — the account that owns the Worker | Worker, D1, KV, Worker secrets, logs | Invite the new developer as a member (Workers + D1 + KV admin). |
| **Meta Business / developers.facebook.com** — the app connected to the Fastchow number | Webhook URL, App Secret, System User "Admin" and its tokens, WhatsApp Flows, message templates | Add them to the Business Manager with admin on the app and the WhatsApp account. |
| **Flutterwave** | API keys, webhook URL and Secret hash, transactions, refunds | Add them as a team member on the Flutterwave dashboard. |

Who owns each account today, and its recovery email and 2FA device, isn't
recorded in the repo. Confirm these before the outgoing developer leaves.

---

## 3. Secrets

Set on the Worker (values can't be read back, only replaced):

| Secret | Used | Notes |
|---|---|---|
| `WHATSAPP_TOKEN` | ✅ | System User token from Meta. |
| `PHONE_NUMBER_ID` | ✅ | Not really secret. |
| `VERIFY_TOKEN` | ✅ | Must match the Meta webhook settings. |
| `WHATSAPP_APP_SECRET` | ✅ | Meta → App settings → Basic. |
| `FLUTTERWAVE_SECRET_KEY` | ✅ | |
| `FLUTTERWAVE_WEBHOOK_SECRET` | ✅ | Must match Flutterwave's webhook Secret hash. |
| `FLUTTERWAVE_PUBLIC_KEY` | ❌ | Set but not used by any code. Safe to delete. |
| `FLUTTERWAVE_ENCRYPTION_KEY` | ❌ | Set but not used by any code. Safe to delete. |

GitHub Actions secret: `CLOUDFLARE_API_TOKEN`. It needs, on the account above:
Workers Scripts Edit, Workers KV Storage Edit, D1 Edit, and Account Settings
Read.

### ⚠️ Rotate before or at handover

These credentials were exposed during the September 2026 work and should be
replaced. Each one only takes effect where it's used, so update those places
too:

1. **Cloudflare API token** (the one in the GitHub secret). Roll it in
   Cloudflare → My Profile → API Tokens, then
   `gh secret set CLOUDFLARE_API_TOKEN` with the new value.
2. **Meta System User token** for the "Admin" system user (valid to
   28 Nov 2026). Revoke it. If the live bot uses the same token, first
   generate a new one and `npx wrangler secret put WHATSAPP_TOKEN`, or the
   bot goes silent.
3. On the old dev server, delete `~/.cf_token` and
   `~/whatsapp-food-bot/.dev.vars`.

In general: anyone who leaves the project should have their tokens rolled. The
ones that matter are the WhatsApp token, the Flutterwave secret key and
webhook secret, the Meta App Secret, and the Cloudflare token.

---

## 4. Known issues and risks

Roughly in order of how likely they are to bite.

1. **WhatsApp's 24-hour rule can silently drop messages.** Free-form messages
   only reach people who messaged the bot in the last 24 hours. This affects
   the new-order alert to admins and order-status updates to customers. Meta
   still answers HTTP 200, so the logs look fine. Fix: get message templates
   approved in Meta and use them (`ORDER_STATUS_TEMPLATE` exists for
   customers; the admin alert has no template support yet). Until then, admins
   should message the bot daily (e.g. send `ADMIN`).
2. **The Add-Item Flow has a fixed category list.** `flows/add-item.json`
   hard-codes category IDs 8/9/10. Adding, renaming or deleting a category
   means editing that file and re-publishing the Flow in Meta. Otherwise
   picking the new category fails. The bot sets KV `flow:stale` and warns
   admins when this happens. The text-based Add Item fallback is unaffected.
3. **No staging environment.** `[env.staging]` in `wrangler.toml` has
   placeholder IDs. Every push to `main` goes straight to customers. Creating
   a real staging D1/KV and a Meta test number is worthwhile before larger
   changes.
4. **Old orders clutter the queue.** As of 29 Sept 2026, five paid orders
   from May were never marked delivered, and 16 unpaid ones sit in
   `pending`/`failed`. Admins can clear them: mark the May orders Delivered,
   and cancel the unpaid ones with Bulk Actions → Orders → Cancelled →
   No, Silent.
5. **Refunds are automatic but should be checked.** Cancelling a paid order
   calls the Flutterwave refund API. The result is logged in `RefundLog` and
   sent to admins, but confirm in the Flutterwave dashboard.
6. **Payment checkout settings are generic.** `FLUTTERWAVE_CALLBACK_URL` is
   `https://flutterwave.com/pay`, so customers land on a Flutterwave page
   after paying, not a FastChow page. `payment_options` in
   `src/payments/flutterwave.js` includes Ghana mobile money and M-Pesa, which
   don't apply to NGN.
7. **Migrations are manual.** No tool tracks which ones have run. Keep every
   change additive and idempotent (see DOCS.md).
8. **Customer names are only kept for 30 days.** The WhatsApp profile name is
   in KV `name:{phone}`, not on the order row. Older orders show only the
   phone number.
9. **CI warnings:** GitHub has deprecated Node 20 for Actions, and the
   project's Wrangler is v3 (v4 is current). Neither breaks anything today.

---

## 5. Code health notes

- `src/handlers/admin.js` (~4,100 lines) and `src/handlers/user.js`
  (~2,000) are large single-file state machines. Comments like `BUG-12`,
  `UX-10` or `EDGE-07` refer to an earlier audit. They explain why odd-looking
  code exists, so read them before "simplifying".
- WhatsApp limits: list rows max 10 in total (titles 24 characters,
  descriptions 72), reply buttons max 3 (titles 20 characters), message body
  1,024 characters. `src/whatsapp.js` silently truncates beyond these, so
  respect the caps when adding rows or buttons. The tests check the important
  ones.
- A legacy bulk "availability only" flow (`bulk_items` in admin.js) can't be
  reached from any menu. It was left in place, not deleted.
- `CLAUDE.md` holds the previous developer's AI-assistant instructions, and
  much of it is about other projects (MewBot, PartyScene). It doesn't describe
  this codebase; ignore it or replace it.

---

## 6. Recent changes (Sept 2026)

- Admins see full order details (customer name and phone, address, notes,
  items, service fee, payment) when opening an order.
- Every admin gets a WhatsApp alert when an order is paid, with one-tap
  **Confirm**.
- The orders list shows only paid orders. The status picker offers only valid
  next steps, and unpaid orders can only be cancelled.
- Name search in the admin item pickers; the admin menu fits WhatsApp's
  10-row limit.
- CI deploys fixed (they had been failing since at least July 2026 because
  the token lacked permissions and `account_id` wasn't pinned).

Full history: `git log`.

---

## 7. First-week checklist for the new developer

- [ ] Get access to GitHub, Cloudflare, Meta and Flutterwave (section 2).
- [ ] Rotate the exposed credentials (section 3).
- [ ] `npm ci && npm test` passes locally.
- [ ] Make a trivial change and push it; watch the Actions run deploy it, then
      `npx wrangler deployments list`.
- [ ] Get added to `AdminUsers` (`node scripts/add-admin.js`), message the bot
      `ADMIN`, and walk the order flow once with a real ₦ test order.
- [ ] Watch `npx wrangler tail` while a real customer orders.
- [ ] Decide on message templates (issue 1) and staging (issue 3).
