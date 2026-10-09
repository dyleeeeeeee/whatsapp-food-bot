# Payments — Flutterwave

How the bot takes payment, how an order gets confirmed as paid, and how to set
up or debug Flutterwave. (Payments moved from Paystack to Flutterwave on
2026-05-24; no Paystack code remains.)

---

## Payment lifecycle

1. **Place order** (`placeOrder` in `src/handlers/user.js`). The bot re-checks
   every cart item is still available at its current price, computes the
   total server-side (items + service fee, in integer kobo), and inserts the
   order and its items in one D1 batch. `payment_reference` is set to a
   checkout ID (`FCHOW-<uuid>`) that is `UNIQUE`. A double tap or a Meta
   retry collides on it and reuses the existing order rather than creating a
   second one.
2. **Payment link.** `initializeFlutterwaveTransaction`
   (`src/payments/flutterwave.js`) creates a Standard Checkout with that
   reference as `tx_ref`. The customer gets the link on WhatsApp, and the
   order's `payment_status` becomes `pending`. If link creation fails, the
   customer can ask for a new link from their order (same reference, so never
   a second charge).
3. **Confirmation.** The order is marked `paid` by whichever happens first:
   - **Webhook:** `POST /flutterwave/webhook`
     (`src/webhooks/flutterwave_handler.js`). It checks the `verif-hash`
     header against `FLUTTERWAVE_WEBHOOK_SECRET`, re-verifies the transaction
     with Flutterwave's API (it never trusts the webhook body), and checks
     status `successful`, currency `NGN`, and amount equal to the order total.
   - **Reconciliation sweep:** every 5 minutes (`src/reconcile.js`), up to 50
     `pending` orders from the last 2 days are re-verified the same way.
   - **Customer checks their order:** the order screen re-verifies a pending
     payment.

   All three call `markOrderPaidAtomic`
   (`UPDATE … WHERE payment_status != 'paid'`). Only the call that actually
   flips the row sends the new-order alert to every admin and, for the
   webhook and sweep, the customer's "Payment Received" receipt (on the third
   path the customer is already looking at their order). So duplicates are
   harmless. The Flutterwave transaction id is stored in
   `payment_access_code` (used for refunds).
4. **Amount mismatch** (paid the wrong amount): via the webhook, the order is
   marked `failed`, admins are alerted, and the customer is told the team
   will contact them. The sweep only alerts admins and leaves the order
   `pending`.
5. **Abandoned payments:** `pending` orders older than 1 day with no
   successful transaction are marked `failed` by the sweep.
6. **Refunds:** an admin cancelling a `paid` order triggers
   `refundFlutterwaveTransaction` with the stored transaction id. The outcome
   (`refunded`, `requested`, `manual` if no id was stored, or `error`) is
   written to `RefundLog`, and admins are alerted. Always confirm in the
   Flutterwave dashboard.

---

## Configuration

| Name | Kind | Required | Notes |
|---|---|---|---|
| `FLUTTERWAVE_SECRET_KEY` | secret | ✅ | v3 secret key (`FLWSECK-…`, or `FLWSECK_TEST-…` for test mode). |
| `FLUTTERWAVE_WEBHOOK_SECRET` | secret | ✅ | Must equal the dashboard's webhook **Secret hash**. Missing or blank means every webhook gets **401**. |
| `FLUTTERWAVE_CALLBACK_URL` | var | ❌ | Where the customer lands after paying. Currently the generic `https://flutterwave.com/pay`. |

There is no public key or encryption key in the code; checkout is created
server-side. (`FLUTTERWAVE_PUBLIC_KEY` and `FLUTTERWAVE_ENCRYPTION_KEY` are set
on the live Worker but unused; see HANDOVER.md.)

Currency is fixed to NGN. `payment_options` is
`card,mobilemoneyghana,mpesa,ussd`; only card and USSD make sense for NGN.

### Dashboard setup

1. Flutterwave dashboard → **Settings → Webhooks**.
2. URL: `https://whatsapp-food-bot.oyinxdoubx.workers.dev/flutterwave/webhook`
   (or your Worker's URL).
3. **Secret hash:** any long random string. Set the same value with
   `npx wrangler secret put FLUTTERWAVE_WEBHOOK_SECRET`.
4. Enable the **charge.completed** event and save.

---

## Testing

Use a Flutterwave test-mode key (`FLWSECK_TEST-…`) against a non-production
Worker. There is no working staging environment yet (`[env.staging]` in
`wrangler.toml` has placeholder IDs), so test mode currently means your own
deployment.

Flutterwave test card (successful): `5531 8866 5214 2950`, CVV `564`,
expiry `09/32`, PIN `3310`, OTP `12345`.
Failing card: `5143 0105 2233 9965`, same CVV/expiry/PIN.
Current list: https://developer.flutterwave.com/docs/test-cards

Checklist:
- [ ] Place an order and receive a payment link.
- [ ] Pay, then check: order `paid`, customer receipt arrives, every admin gets the alert.
- [ ] Re-send the same webhook. Nothing happens a second time.
- [ ] Wrong `verif-hash` returns 401.
- [ ] Cancel the paid order as admin: refund attempted, a `RefundLog` row written, admins alerted.

Automated coverage: `tests/orders.test.mjs` (idempotent order creation, atomic
paid flip), `tests/reconcile.test.mjs` (sweep, mismatches, age-out, one admin
alert per order).

---

## Debugging

Logs: `npx wrangler tail --format pretty`, or Cloudflare dashboard → Worker → Logs.

| Log line | Meaning |
|---|---|
| `[Flutterwave] Initialization error` | Payment link creation failed. Check the secret key and the amount (minimum ₦100). |
| `401` on `/flutterwave/webhook` | Secret hash mismatch, or `FLUTTERWAVE_WEBHOOK_SECRET` unset. |
| `[Flutterwave] CRITICAL: Amount mismatch` | Customer paid a different amount. Order marked failed, admins alerted. |
| `[Flutterwave] Order #X already paid; skipping duplicate` | Normal: a duplicate webhook was ignored. |
| `[Flutterwave] Order #X successfully marked as paid.` | Success. |
| `[Reconcile] …` | Sweep activity; mismatches also trigger admin alerts. |

If webhooks were failing, fix the secret. The sweep confirms the affected
payments from the last 2 days within 5 minutes, so there's nothing to replay
by hand. Older ones must be checked in the Flutterwave dashboard and updated
manually.

Rolling back a bad deploy: `git revert <commit> && git push origin main` (CI
redeploys), or redeploy an older version with
`npx wrangler rollback` / `npx wrangler versions deploy`.

---

## References

- Code: `src/payments/flutterwave.js`, `src/webhooks/flutterwave_handler.js`,
  `src/reconcile.js`, `placeOrder` in `src/handlers/user.js`,
  `attemptPaidCancelRefund` in `src/handlers/admin.js`.
- Flutterwave docs: https://developer.flutterwave.com/docs ·
  [Webhooks](https://developer.flutterwave.com/docs/webhooks)
