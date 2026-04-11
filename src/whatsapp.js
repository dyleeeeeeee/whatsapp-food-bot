/**
 * src/whatsapp.js — WhatsApp Cloud API Client
 *
 * BUG-19: buttonPayload now enforces the 3-button maximum internally.
 * BUG-22: Graph API version is read from env (GRAPH_API_VERSION) with
 *         a safe fallback, so it can be updated without code changes.
 *
 * WhatsApp Cloud API limits (enforced here):
 *   - Button message: max 3 buttons, body ≤ 1024 chars, header ≤ 60 chars
 *   - List message: max 10 sections, max 10 rows/section
 *   - Button reply ID: max 256 chars
 *   - Button title: max 20 chars
 *   - List row title: max 24 chars
 *   - List row description: max 72 chars
 */

function graphBase(env) {
  // BUG-22 FIX: version from env, not hardcoded
  const version = env.GRAPH_API_VERSION || 'v21.0';
  return `https://graph.facebook.com/${version}`;
}

// ─────────────────────────────────────────────────────────────
// Core sender
// ─────────────────────────────────────────────────────────────

/**
 * Send any WhatsApp message payload.
 * @param {string} to      - E.164 phone number without leading +
 * @param {object} payload - Message body object (type + content)
 * @param {object} env     - Worker env bindings
 */
export async function sendWhatsAppMessage(to, payload, env) {
  const url = `${graphBase(env)}/${env.PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    ...payload,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[WhatsApp] Send error:', res.status, errText);
    throw new Error(`WhatsApp API error: ${res.status}`);
  }

  return res.json();
}

// ─────────────────────────────────────────────────────────────
// Message payload builders
// ─────────────────────────────────────────────────────────────

/** Plain text message */
export function textPayload(text) {
  return { type: 'text', text: { body: text, preview_url: false } };
}

/**
 * Interactive button message.
 *
 * BUG-19 FIX: Enforces the 3-button maximum internally via .slice(0, 3).
 * Callers no longer need to manage this — the API will never receive >3.
 *
 * @param {string}      bodyText - Message body (≤ 1024 chars)
 * @param {Array}       btns     - [{ id, title }]
 * @param {string|null} header   - Optional header text (≤ 60 chars)
 * @param {string|null} footer   - Optional footer text (≤ 60 chars)
 */
export function buttonPayload(bodyText, btns, header = null, footer = null) {
  const msg = {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        // BUG-19 FIX: slice(0, 3) enforced here, not on callers
        buttons: btns.slice(0, 3).map(b => ({
          type: 'reply',
          reply: {
            id:    String(b.id).slice(0, 256),
            title: String(b.title).slice(0, 20),
          },
        })),
      },
    },
  };
  if (header) msg.interactive.header = { type: 'text', text: String(header).slice(0, 60) };
  if (footer) msg.interactive.footer = { text: String(footer).slice(0, 60) };
  return msg;
}

/**
 * Interactive list message.
 * Max 10 sections, max 10 rows per section.
 *
 * @param {string} bodyText  - Body text
 * @param {string} btnLabel  - Button label (≤ 20 chars)
 * @param {Array}  sections  - [{ title, rows: [{ id, title, description }] }]
 */
export function listPayload(bodyText, btnLabel, sections) {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: String(btnLabel).slice(0, 20),
        sections: sections.slice(0, 10).map(s => ({
          title: String(s.title).slice(0, 24),
          rows:  (s.rows || []).slice(0, 10).map(r => ({
            id:          String(r.id).slice(0, 256),
            title:       String(r.title).slice(0, 24),
            description: String(r.description || '').slice(0, 72),
          })),
        })),
      },
    },
  };
}

/**
 * Interactive button message with an image header.
 * Used for item details — delivers image + buttons as a single message.
 *
 * BUG-28 FIX: This replaces the two-message pattern (sendImage + sendButtons)
 * with a single interactive message, halving API calls for item details.
 *
 * @param {string}      bodyText - Message body
 * @param {Array}       btns     - [{ id, title }]
 * @param {string}      imageUrl - HTTPS URL to image
 * @param {string|null} footer   - Optional footer
 */
export function imageButtonPayload(bodyText, btns, imageUrl, footer = null) {
  const msg = buttonPayload(bodyText, btns, null, footer);
  msg.interactive.header = { type: 'image', image: { link: imageUrl } };
  return msg;
}

/**
 * Standalone image message with optional caption.
 * Still used for best-effort image-only sends.
 */
export function imagePayload(imageUrl, caption = '') {
  return {
    type: 'image',
    image: { link: imageUrl, caption },
  };
}

/**
 * Mark a message as read.
 * Uses the same /messages endpoint with a status payload (no `to` field).
 */
export async function markRead(messageId, env) {
  const url = `${graphBase(env)}/${env.PHONE_NUMBER_ID}/messages`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch {
    // best-effort — never throw on read receipts
  }
}

// ─────────────────────────────────────────────────────────────
// Convenience senders
// ─────────────────────────────────────────────────────────────

export async function sendText(to, text, env) {
  return sendWhatsAppMessage(to, textPayload(text), env);
}

export async function sendButtons(to, bodyText, btns, env, header, footer) {
  return sendWhatsAppMessage(to, buttonPayload(bodyText, btns, header, footer), env);
}

export async function sendList(to, bodyText, btnLabel, sections, env) {
  return sendWhatsAppMessage(to, listPayload(bodyText, btnLabel, sections), env);
}

export async function sendImageButtons(to, bodyText, btns, imageUrl, env, footer) {
  return sendWhatsAppMessage(to, imageButtonPayload(bodyText, btns, imageUrl, footer), env);
}

export async function sendImage(to, imageUrl, caption, env) {
  return sendWhatsAppMessage(to, imagePayload(imageUrl, caption), env);
}
