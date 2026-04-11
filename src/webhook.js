/**
 * src/webhook.js — Webhook Entry & Message Dispatcher
 *
 * BUG-03: Message deduplication using wamid stored in KV (1h TTL).
 *         Meta retries delivery if it doesn't get a 200 within 20s.
 *         Without dedup, a slow order write causes duplicate orders.
 *
 * BUG-26: Unsupported message types now get a friendly fallback reply
 *         instead of silence (which makes the bot appear broken).
 *
 * BUG-27: All messages in the payload are processed, not just messages[0].
 *         WhatsApp can batch multiple messages in a single webhook delivery.
 */

import { handleUserMessage } from './handlers/user.js';
import { handleAdminMessage } from './handlers/admin.js';
import { isAdmin } from './security.js';
import { sendText } from './whatsapp.js';

// ─────────────────────────────────────────────────────────────
// GET — Meta webhook verification
// ─────────────────────────────────────────────────────────────

export function handleWebhookGet(request, env) {
  const url       = new URL(request.url);
  const mode      = url.searchParams.get('hub.mode');
  const token     = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === env.VERIFY_TOKEN) {
    console.log('[Webhook] Verification successful');
    return new Response(challenge, { status: 200 });
  }
  console.warn('[Webhook] Verification failed — token mismatch');
  return new Response('Forbidden', { status: 403 });
}

// ─────────────────────────────────────────────────────────────
// POST — Incoming message dispatcher
// ─────────────────────────────────────────────────────────────

export async function handleWebhookPost(body, env) {
  try {
    const entry   = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    // Ignore delivery receipts and read confirmations
    if (value?.statuses) return;

    // BUG-27 FIX: process ALL messages in the payload, not just [0]
    const messages = value?.messages;
    if (!messages?.length) return;

    for (const message of messages) {
      await processMessage(message, env);
    }
  } catch (err) {
    console.error('[Webhook] handleWebhookPost error:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// Per-message processing
// ─────────────────────────────────────────────────────────────

async function processMessage(message, env) {
  const from   = message.from;  // E.164 without +
  const wamid  = message.id;    // WhatsApp message ID — unique per message
  const type   = message.type;

  if (!from || !wamid) {
    console.warn('[Webhook] Message missing from or id — skipping');
    return;
  }

  // BUG-03 FIX: Deduplicate using wamid in KV.
  // Meta retries webhooks on timeout — without this, a slow D1 write
  // during order placement causes createOrder to run twice.
  const dedupKey = `dedup:${wamid}`;
  try {
    const seen = await env.SESSION_KV.get(dedupKey);
    if (seen) {
      console.log('[Webhook] Duplicate message ignored:', wamid);
      return;
    }
    // Mark as seen before processing — 1h TTL is sufficient
    await env.SESSION_KV.put(dedupKey, '1', { expirationTtl: 3600 });
  } catch (err) {
    // KV outage — log but continue. Risk: rare duplicate on KV failure.
    // Safer to process a potential duplicate than to drop all messages.
    console.warn('[Webhook] KV dedup unavailable, processing anyway:', err);
  }

  const parsed = parseMessage(message);

  if (!parsed) {
    // BUG-26 FIX: Unsupported types (photo, voice, sticker, location, etc.)
    // previously returned silently, making the bot appear dead. Now we
    // send a friendly nudge so users know what to do.
    console.log('[Webhook] Unsupported message type:', type);
    await sendText(
      from,
      '🤖 I only understand text messages and button taps.\n\nSend *MENU* to start ordering!',
      env
    ).catch(err => console.error('[Webhook] Failed to send type-fallback reply:', err));
    return;
  }

  // Route to admin or customer handler
  const admin = await isAdmin(from, env);
  if (admin) {
    await handleAdminMessage(from, parsed, env);
  } else {
    await handleUserMessage(from, parsed, env);
  }
}

// ─────────────────────────────────────────────────────────────
// Message parser — normalise all types to a common shape
// ─────────────────────────────────────────────────────────────

function parseMessage(message) {
  const type = message.type;

  if (type === 'text') {
    return { type: 'text', text: message.text?.body?.trim() || '' };
  }

  if (type === 'interactive') {
    const interactive = message.interactive;
    if (!interactive) return null;

    if (interactive.type === 'button_reply') {
      const r = interactive.button_reply;
      if (!r?.id) return null;
      return { type: 'button_reply', id: r.id, title: r.title || '' };
    }

    if (interactive.type === 'list_reply') {
      const r = interactive.list_reply;
      if (!r?.id) return null;
      return { type: 'list_reply', id: r.id, title: r.title || '' };
    }
  }

  return null; // audio, image, video, sticker, location, contacts, etc.
}
