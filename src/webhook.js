/**
 * src/webhook.js — Webhook Entry & Message Parser
 */

import { handleUserMessage } from './handlers/user.js';
import { handleAdminMessage } from './handlers/admin.js';
import { isAdmin } from './security.js';

// ─────────────────────────────────────────────────────────────
// GET — Meta webhook verification
// ─────────────────────────────────────────────────────────────

export function handleWebhookGet(request, env) {
  const url = new URL(request.url);
  const mode      = url.searchParams.get('hub.mode');
  const token     = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === env.VERIFY_TOKEN) {
    console.log('[Webhook] Verified');
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// ─────────────────────────────────────────────────────────────
// POST — Incoming message dispatch
// ─────────────────────────────────────────────────────────────

export async function handleWebhookPost(body, env) {
  try {
    const entry    = body?.entry?.[0];
    const changes  = entry?.changes?.[0];
    const value    = changes?.value;

    // Ignore status updates (delivery receipts, reads)
    if (value?.statuses) return;

    const message = value?.messages?.[0];
    if (!message) return;

    const from    = message.from;   // E.164 without +
    const msgType = message.type;   // text | interactive | image | ...

    // Parse the incoming message into a normalised object
    const parsed = parseMessage(message);
    if (!parsed) {
      console.log('[Webhook] Unsupported message type:', msgType);
      return;
    }

    // Route to admin or user handler
    const admin = await isAdmin(from, env);
    if (admin) {
      await handleAdminMessage(from, parsed, env);
    } else {
      await handleUserMessage(from, parsed, env);
    }
  } catch (err) {
    console.error('[Webhook] handleWebhookPost error:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// Message parser → normalised shape
// ─────────────────────────────────────────────────────────────

function parseMessage(message) {
  const type = message.type;

  if (type === 'text') {
    return { type: 'text', text: message.text?.body?.trim() || '' };
  }

  if (type === 'interactive') {
    const interactive = message.interactive;

    if (interactive.type === 'button_reply') {
      return {
        type: 'button_reply',
        id:    interactive.button_reply.id,
        title: interactive.button_reply.title,
      };
    }

    if (interactive.type === 'list_reply') {
      return {
        type: 'list_reply',
        id:    interactive.list_reply.id,
        title: interactive.list_reply.title,
      };
    }
  }

  return null;
}
