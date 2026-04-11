# WhatsApp Food Bot — Deployment Guide

A production-ready food ordering bot built on Cloudflare Workers + WhatsApp Cloud API.

---

## Stack

| Layer         | Technology              |
|---------------|-------------------------|
| Runtime       | Cloudflare Workers      |
| State/Cache   | Cloudflare KV           |
| Database      | Cloudflare D1 (SQLite)  |
| Media         | Cloudflare R2 (optional)|
| Messaging     | WhatsApp Cloud API      |

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) (free tier works)
- [Meta Developer account](https://developers.facebook.com)
- [Node.js 18+](https://nodejs.org) + [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

```bash
npm install -g wrangler
wrangler login
```

---

## Step 1 — Create Cloudflare Resources

### KV Namespace

```bash
wrangler kv:namespace create SESSION_KV
wrangler kv:namespace create SESSION_KV --preview
```

Copy the `id` and `preview_id` values into `wrangler.toml`.

### D1 Database

```bash
wrangler d1 create food-bot-db
```

Copy the `database_id` into `wrangler.toml`.

### Apply Schema

```bash
# Apply to local (dev)
wrangler d1 execute food-bot-db --local --file=schema.sql

# Apply to production
wrangler d1 execute food-bot-db --file=schema.sql
```

---

## Step 2 — Meta / WhatsApp Setup

1. Go to [developers.facebook.com](https://developers.facebook.com) → Create App → Business
2. Add **WhatsApp** product to your app
3. In WhatsApp → Getting Started, note:
   - **Phone Number ID**
   - **WhatsApp Business Account ID**
4. Generate a **Temporary Access Token** (use a permanent System User token for prod)

---

## Step 3 — Set Secrets

```bash
# WhatsApp permanent token
wrangler secret put WHATSAPP_TOKEN

# Your phone number ID from Meta dashboard
wrangler secret put PHONE_NUMBER_ID

# A random string you choose (used in webhook verification)
wrangler secret put VERIFY_TOKEN

# App Secret from Meta App Settings (for signature verification)
wrangler secret put WHATSAPP_APP_SECRET
```

---

## Step 4 — Seed Admin User

```bash
wrangler d1 execute food-bot-db --command \
  "INSERT INTO AdminUsers (phone_number, name) VALUES ('1XXXXXXXXXX', 'Your Name');"
```

> Phone number must be in E.164 format **without** the `+` prefix.
> e.g. US number +1 555 123 4567 → `15551234567`

---

## Step 5 — Deploy Worker

```bash
wrangler deploy
```

Your Worker URL will be:
```
https://whatsapp-food-bot.<your-subdomain>.workers.dev
```

---

## Step 6 — Register Webhook in Meta

1. Meta Dashboard → WhatsApp → Configuration
2. **Webhook URL**: `https://whatsapp-food-bot.<subdomain>.workers.dev/webhook`
3. **Verify Token**: same value you set in `VERIFY_TOKEN`
4. Click **Verify and Save**
5. Subscribe to: `messages`

---

## Step 7 — Test

Send a WhatsApp message to your test number. You should receive the welcome menu.

**Admin test**: Send `ADMIN` from your admin phone number.

---

## Environment Variables Reference

| Variable              | Required | Description                              |
|-----------------------|----------|------------------------------------------|
| `WHATSAPP_TOKEN`      | ✅        | Bearer token for Meta API calls          |
| `PHONE_NUMBER_ID`     | ✅        | Your WhatsApp Phone Number ID            |
| `VERIFY_TOKEN`        | ✅        | Webhook verification shared secret       |
| `WHATSAPP_APP_SECRET` | ✅        | App Secret for signature verification    |
| `MENU_CACHE_TTL`      | ❌        | Seconds to cache menu in KV (default 300)|
| `ENVIRONMENT`         | ❌        | `production` / `development`             |

---

## State Machine Diagram

```
User sends any message
        │
        ▼
   ┌──────────┐
   │   idle   │◄──────────────────────────────┐
   └──────────┘                               │
        │ "View Menu"                         │
        ▼                                     │
 ┌──────────────┐                             │
 │browsing_menu │                             │
 └──────────────┘                             │
        │ select category                     │
        ▼                                     │
 ┌───────────────┐                            │
 │selecting_item │                            │
 └───────────────┘                            │
        │ select item                         │
        ▼                                     │
 ┌─────────────┐                              │
 │ item_detail │                              │
 └─────────────┘                              │
        │ "Add to Cart"                       │
        ▼                                     │
 ┌──────────────────┐                         │
 │entering_quantity │                         │
 └──────────────────┘                         │
        │ enter number                        │
        ▼                                     │
 ┌───────────────┐                            │
 │entering_notes │                            │
 └───────────────┘                            │
        │                                     │
        ▼                                     │
 ┌─────────────┐     keep shopping            │
 │ cart_review │─────────────────────────┐    │
 └─────────────┘                         │    │
        │ checkout                        │    │
        ▼                                 ▼    │
 ┌──────────────────┐          ┌──────────────┐│
 │checkout_address  │          │browsing_menu ││
 └──────────────────┘          └──────────────┘│
        │ enter address                        │
        ▼                                      │
 ┌──────────────────┐                          │
 │checkout_confirm  │                          │
 └──────────────────┘                          │
        │ "Place Order" → save to D1           │
        └──────────────────────────────────────┘
```

---

## KV Key Layout

| Key                   | TTL     | Content                              |
|-----------------------|---------|--------------------------------------|
| `session:{phone}`     | 2 hours | Session state + cart JSON            |
| `menu:cache`          | 5 min   | Full serialised menu from D1         |

---

## Costs (Free Tier Estimates)

| Resource         | Free Tier           | Typical Usage                |
|------------------|---------------------|------------------------------|
| Workers requests | 100K/day            | ~1 req per message           |
| KV reads         | 100K/day            | ~2–3 per message             |
| KV writes        | 1K/day              | ~1 per message               |
| D1 reads         | 5M rows/day         | Menu + order queries         |
| D1 writes        | 100K rows/day       | Order creation only          |

A bot handling **5,000 orders/day** comfortably fits the free tier.

---

## Multi-Tenant Extension

To support multiple restaurants:

1. Add `tenant_id` column to all D1 tables
2. Add `TENANT_ID` env var per Worker deployment
3. Filter all queries by `tenant_id`
4. Or: deploy a separate Worker per tenant (completely isolated)

---

## Troubleshooting

| Issue                          | Fix                                                    |
|--------------------------------|--------------------------------------------------------|
| Webhook verification fails     | Check `VERIFY_TOKEN` matches Meta dashboard            |
| 403 on POST                    | Set `WHATSAPP_APP_SECRET`, or set `ENVIRONMENT=development` |
| Messages not received          | Verify webhook subscription includes `messages`        |
| D1 errors                      | Run `schema.sql` against production D1                 |
| Menu not updating              | Bust KV cache: `wrangler kv:key delete menu:cache --binding SESSION_KV` |
