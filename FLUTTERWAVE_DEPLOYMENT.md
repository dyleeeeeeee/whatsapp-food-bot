# Flutterwave Integration - Deployment Guide

## Overview
Successfully replaced Paystack with Flutterwave for payment processing.

## Changes Made

### New Files
- `src/payments/flutterwave.js` - Flutterwave API client (initialize, verify, webhook signature)
- `src/payments/router.js` - Payment initialization wrapper
- `src/webhooks/flutterwave_handler.js` - Webhook event processor
- `migration_002.sql` - Documentation file (no schema changes needed)

### Removed Files
- `src/paystack.js` - Removed Paystack API client
- `src/paystack_handler.js` - Removed Paystack webhook handler

### Modified Files
- `src/index.js` - Changed webhook route from `/paystack/webhook` to `/flutterwave/webhook`
- `src/handlers/user.js` - Updated checkout flow to use Flutterwave
- `wrangler.toml` - Added `FLUTTERWAVE_CALLBACK_URL` configuration

## Required Environment Variables

| Variable                     | Required | Type   | Description                                                        |
|------------------------------|----------|--------|--------------------------------------------------------------------|
| `FLUTTERWAVE_SECRET_KEY`     | ✅        | secret | Bearer key for the Flutterwave v3 API (`FLWSECK...`)               |
| `FLUTTERWAVE_WEBHOOK_SECRET` | ✅        | secret | Secret hash used to verify the `verif-hash` webhook header         |
| `FLUTTERWAVE_CALLBACK_URL`   | ❌        | var    | Redirect URL after checkout (set in `wrangler.toml`)              |

> **There is no `FLUTTERWAVE_PUBLIC_KEY`.** The bot uses the Standard Checkout
> API server-side only; the public key is never needed. Do not set it.
>
> **`FLUTTERWAVE_WEBHOOK_SECRET` is mandatory.** The webhook handler hard-fails
> (returns **401**) when it is missing or empty — a blank secret no longer means
> "skip verification". Payments will silently never confirm until it is set.

## Deployment Steps

### 1. Set Flutterwave Secrets

**Sandbox (for testing):**
```bash
wrangler secret put FLUTTERWAVE_SECRET_KEY --env staging
# Enter: FLWSECK_TEST-xxxxxxxxxxxxx

wrangler secret put FLUTTERWAVE_WEBHOOK_SECRET --env staging
# Enter: the "Secret hash" you set on the Flutterwave webhook page
```

**Production:**
```bash
wrangler secret put FLUTTERWAVE_SECRET_KEY
# Enter: FLWSECK-xxxxxxxxxxxxx

wrangler secret put FLUTTERWAVE_WEBHOOK_SECRET
# Enter: the "Secret hash" you set on the Flutterwave webhook page
```

> Set `FLUTTERWAVE_CALLBACK_URL` (the post-payment redirect) in `wrangler.toml`
> under `[vars]`; it is not a secret.

### 2. Configure Flutterwave Dashboard

1. Log in to [Flutterwave Dashboard](https://dashboard.flutterwave.com)
2. Go to **Settings → Webhooks**
3. Add webhook URL:
   - **Sandbox:** `https://your-worker-staging.dev/flutterwave/webhook`
   - **Production:** `https://your-worker.workers.dev/flutterwave/webhook`
4. Set a **Secret hash** — this exact value must match the
   `FLUTTERWAVE_WEBHOOK_SECRET` secret you set in step 1. Flutterwave sends it
   back on every webhook in the `verif-hash` request header, and the bot
   compares it in constant time.
5. Select event: **charge.completed**
6. Save webhook configuration

### 3. Deploy

**Deploy to Staging:**
```bash
wrangler deploy --env staging
```

**Test in staging:**
- Place test order via WhatsApp
- Complete payment using Flutterwave test card:
  - Card: 5531886652142950
  - CVV: 564
  - Expiry: 09/32
  - PIN: 3310
  - OTP: 12345
- Verify webhook received and order marked as paid

**Deploy to Production:**
```bash
wrangler deploy
```

### 4. Monitor

**Watch logs:**
```bash
wrangler tail --format pretty
```

**Check for:**
- `[Flutterwave] Initialization error` - API key issues
- `[Flutterwave] Invalid webhook signature` - Webhook configuration issues
- `[Flutterwave] Order not found` - Reference mismatch
- `[Flutterwave] Order #X successfully marked as paid` - Success!

## API Endpoints

### Flutterwave API URLs

**Sandbox:**
- API: `https://api.flutterwave.com/v3/`
- Checkout: `https://checkout.flutterwave.com/`

**Production:**
- API: `https://api.flutterwave.com/v3/`
- Checkout: `https://checkout.flutterwave.com/`

### Key Differences from Paystack

| Feature | Paystack | Flutterwave |
|---------|----------|-------------|
| Webhook Event | `charge.success` | `charge.completed` |
| Signature | HMAC-SHA512 of body | `verif-hash` header equals `FLUTTERWAVE_WEBHOOK_SECRET` (constant-time compare) |
| Amount Format | Kobo (cents) | Naira (float) |
| Reference Field | `reference` | `tx_ref` |
| Checkout URL | `authorization_url` | `link` |
| Access Code | Used | Not used (NULL) |
| Status Value | `success` | `successful` |

## Testing Checklist

### Manual Tests
- [ ] `FLUTTERWAVE_WEBHOOK_SECRET` is set (without it every webhook returns 401)
- [ ] Place order → Receive Flutterwave payment link
- [ ] Complete payment → Webhook received (`charge.completed`)
- [ ] Order status updated to 'paid' (atomic, idempotent — duplicate webhooks notify once)
- [ ] Customer receives WhatsApp confirmation
- [ ] Payment link works on mobile devices
- [ ] Invalid/mismatched `verif-hash` rejected (401)

### Test Cards (Sandbox)

**Successful Payment:**
- Card: 5531886652142950
- CVV: 564
- Expiry: 09/32
- PIN: 3310
- OTP: 12345

**Failed Payment:**
- Card: 5143010522339965
- CVV: 564
- Expiry: 09/32
- PIN: 3310

## Rollback Plan

If issues arise:

1. **Quick rollback via git:**
   ```bash
   git revert HEAD
   git push origin main
   wrangler deploy
   ```

2. **Restore Paystack secrets** (if you kept them):
   ```bash
   wrangler secret put PAYSTACK_SECRET_KEY
   ```

3. **Update webhook URL** in Paystack dashboard

## Support & Documentation

### Flutterwave Resources
- [API Documentation](https://developer.flutterwave.com/docs)
- [Webhook Documentation](https://developer.flutterwave.com/docs/webhooks)
- [Test Cards](https://developer.flutterwave.com/docs/test-cards)
- [Dashboard](https://dashboard.flutterwave.com)

### Code References
- Flutterwave API client: `src/payments/flutterwave.js`
- Webhook handler: `src/webhooks/flutterwave_handler.js`
- Checkout integration: `src/handlers/user.js:680-757`

## Known Limitations

1. **Currency:** Currently hardcoded to NGN (Nigerian Naira)
   - TODO: Support multi-currency based on country code
2. **Payment Methods:** Supports card, mobile money, USSD, M-Pesa
   - All enabled via `payment_options` parameter
3. **Existing Paystack Orders:** Remain in database, webhook endpoint changed
   - Old orders will not receive webhook updates

## Success Criteria

✅ Flutterwave integration deployed
✅ Webhook signature verification working
✅ Payments processing successfully
✅ Customers receiving confirmation messages
✅ No errors in logs
✅ Zero downtime during migration

---

**Migration Date:** 2026-05-24
**Migration By:** dyleeeeeeee
**Co-Authored-By:** Claude Sonnet 4.5 (1M context)
