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
import { sendText, sendTypingIndicator } from './whatsapp.js';
import { getSession } from './session.js';

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

    // BUG-13 FIX: load ONE session per distinct 'from' for the whole batch.
    // Previously each message loaded its own session from KV, so in-memory
    // mutations from message[0] were lost before message[1] ran (KV writes
    // are eventually consistent). Reusing the same object lets later messages
    // observe earlier ones' state changes within a single webhook delivery.
    const sessions = new Map(); // from -> session object (shared across batch)

    for (const message of messages) {
      const from = message.from;
      let preSession = null;
      if (from) {
        if (!sessions.has(from)) {
          sessions.set(from, await getSession(from, env));
        }
        preSession = sessions.get(from);
      }
      // Isolate each message: a thrown (poison) message deletes its own dedup
      // key and re-throws so a re-delivery can retry it — but it must NOT abort
      // the rest of the batch, which share the same preSession threading.
      try {
        await processMessage(message, env, preSession);
      } catch (err) {
        console.error('[Webhook] processMessage failed (dedup key cleared for retry):', err);
      }
    }
  } catch (err) {
    console.error('[Webhook] handleWebhookPost error:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// Per-message processing
// ─────────────────────────────────────────────────────────────

async function processMessage(message, env, preSession = null) {
  const from   = message.from;  // E.164 without +
  const wamid  = message.id;    // WhatsApp message ID — unique per message
  const type   = message.type;

  if (!from || !wamid) {
    console.warn('[Webhook] Message missing from or id — skipping');
    return;
  }

  // PII: never log the full phone or any free-text message body. Only the
  // last 4 digits of the sender and the message type/id are safe to log.
  const fromTail = from.slice(-4);
  console.log('[Webhook] Processing message:', { from: fromTail, type, wamid: wamid?.slice(-8) });

  // BUG-03 FIX: Deduplicate using wamid in KV.
  // Meta retries webhooks on timeout — without this, a slow D1 write
  // during order placement causes createOrder to run twice.
  //
  // POISON-MESSAGE FIX: keep the pre-check read so true duplicates are
  // dropped, but only WRITE the dedup key AFTER the handler resolves
  // successfully. If the handler throws, Meta's retry must be allowed to
  // re-deliver — so we drop the key (it was never written) and let the
  // error propagate. Writing before processing would mark a failed message
  // as "seen" and permanently suppress its retry.
  const dedupKey = `dedup:${wamid}`;
  try {
    const seen = await env.SESSION_KV.get(dedupKey);
    if (seen) {
      console.log('[Webhook] Duplicate message ignored:', wamid);
      return;
    }
  } catch (err) {
    // KV outage — log but continue. Risk: rare duplicate on KV failure.
    // Safer to process a potential duplicate than to drop all messages.
    console.warn('[Webhook] KV dedup read unavailable, processing anyway:', err);
  }

  // UX-06: best-effort read receipt + typing indicator so the user sees the
  // bot is "working" while we route the message. Never throws.
  sendTypingIndicator(from, wamid, env).catch(() => {});

  const parsed = parseMessage(message);
  // PII: do NOT log the parsed payload — it carries the user's free-text
  // message body. Only the message type is safe to log.
  console.log('[Webhook] Parsed type:', parsed?.type ?? 'unsupported');

  if (!parsed) {
    // BP-01: Unsupported types (voice, sticker, contacts, etc.) previously
    // returned silently. We now acknowledge the things the bot DOES support
    // (buttons + lists) and handle a shared location gracefully instead of
    // wrongly claiming we only understand "text and button taps".
    console.log('[Webhook] Unsupported message type:', type);
    const fallback = type === 'location'
      ? '📍 Thanks for sharing your location! I can\'t read map pins yet — please type your delivery address as text.\n\nSend *MENU* to start ordering!'
      : '🤖 I understand text, button taps, and list selections.\n\nSend *MENU* to start ordering!';
    await sendText(from, fallback, env)
      .catch(err => console.error('[Webhook] Failed to send type-fallback reply:', err));
    // An unsupported message was fully handled (acknowledged). Mark it seen
    // so a retry doesn't re-send the fallback.
    await markSeen(env, dedupKey);
    return;
  }

  // Route to admin or customer handler. BUG-13: pass the shared preSession so
  // batched messages from the same 'from' reuse one in-memory session object.
  // POISON-MESSAGE FIX: on a thrown handler, DELETE the dedup key (best-effort)
  // so Meta's retry can re-deliver, then re-throw to signal failure upstream.
  try {
    const admin = await isAdmin(from, env);
    if (admin) {
      await handleAdminMessage(from, parsed, env, preSession);
    } else {
      await handleUserMessage(from, parsed, env, preSession);
    }
  } catch (err) {
    await env.SESSION_KV.delete(dedupKey).catch(() => {});
    throw err;
  }

  // Handler resolved successfully — NOW mark the message as seen so Meta's
  // retry is dropped as a true duplicate.
  await markSeen(env, dedupKey);
}

// Mark a wamid as processed in KV (1h TTL is sufficient for Meta's retry
// window). Best-effort: a KV write failure must not fail an already-handled
// message — the worst case is a rare duplicate on retry.
async function markSeen(env, dedupKey) {
  try {
    await env.SESSION_KV.put(dedupKey, '1', { expirationTtl: 3600 });
  } catch (err) {
    console.warn('[Webhook] KV dedup write failed:', err);
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

    // UX-03: WhatsApp Flow completion. The submitted screen data arrives as a
    // JSON string in response_json; parse it for the handler to consume.
    if (interactive.type === 'nfm_reply') {
      const r = interactive.nfm_reply;
      let data = null;
      try {
        data = r?.response_json ? JSON.parse(r.response_json) : null;
      } catch (err) {
        console.warn('[Webhook] nfm_reply response_json parse failed:', err);
        return null;
      }
      return { type: 'flow_reply', data };
    }

    return null;
  }

  // UX-03: shared location pin — surface coordinates + any label/address.
  if (type === 'location') {
    const loc = message.location;
    if (!loc) return null;
    return {
      type:      'location',
      latitude:  loc.latitude,
      longitude: loc.longitude,
      name:      loc.name || '',
      address:   loc.address || '',
    };
  }

  // UX-03: inbound image (e.g. proof of payment). Caption is a free-text hint.
  if (type === 'image') {
    const img = message.image;
    if (!img) return null;
    return {
      type:      'image',
      id:        img.id || '',
      mimeType:  img.mime_type || '',
      caption:   img.caption || '',
    };
  }

  // UX-03: shared contact card(s).
  if (type === 'contacts') {
    const contacts = message.contacts;
    if (!contacts?.length) return null;
    return { type: 'contacts', contacts };
  }

  // UX-03: emoji reaction to a previous message.
  if (type === 'reaction') {
    const r = message.reaction;
    if (!r) return null;
    return { type: 'reaction', emoji: r.emoji || '', messageId: r.message_id || '' };
  }

  // UX-03: template quick-reply button tap (distinct from interactive replies).
  if (type === 'button') {
    const b = message.button;
    if (!b) return null;
    return { type: 'button', text: b.text || '' };
  }

  return null; // audio, video, sticker, etc.
}
