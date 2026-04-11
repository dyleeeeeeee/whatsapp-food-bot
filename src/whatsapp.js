/**
 * src/whatsapp.js — WhatsApp Cloud API Client
 *
 * All outbound message types in one place.
 * Uses native fetch — zero dependencies.
 */

const BASE = 'https://graph.facebook.com/v19.0';

// ─────────────────────────────────────────────────────────────
// Core sender
// ─────────────────────────────────────────────────────────────

/**
 * Send any WhatsApp message payload.
 * @param {string} to   - E.164 phone number (e.g. "15551234567")
 * @param {object} payload - Message body object
 * @param {object} env  - Worker env bindings
 */
export async function sendWhatsAppMessage(to, payload, env) {
  const url = `${BASE}/${env.PHONE_NUMBER_ID}/messages`;

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
    const err = await res.text();
    console.error('[WhatsApp] Send error:', res.status, err);
    throw new Error(`WhatsApp API error: ${res.status}`);
  }

  return res.json();
}

// ─────────────────────────────────────────────────────────────
// Message type helpers
// ─────────────────────────────────────────────────────────────

/** Plain text message */
export function textPayload(text) {
  return { type: 'text', text: { body: text, preview_url: false } };
}

/**
 * Interactive button message (max 3 buttons)
 * @param {string} body  - Body text
 * @param {Array}  btns  - [{ id, title }]
 * @param {string} [header]
 * @param {string} [footer]
 */
export function buttonPayload(body, btns, header = null, footer = null) {
  const msg = {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: btns.map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  };
  if (header) msg.interactive.header = { type: 'text', text: header };
  if (footer) msg.interactive.footer = { text: footer };
  return msg;
}

/**
 * Interactive list message (max 10 sections / 10 rows each)
 * @param {string} body     - Body text
 * @param {string} btnLabel - Button label (e.g. "Browse")
 * @param {Array}  sections - [{ title, rows: [{ id, title, description }] }]
 */
export function listPayload(body, btnLabel, sections) {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body },
      action: {
        button: btnLabel.slice(0, 20),
        sections: sections.map(s => ({
          title: s.title.slice(0, 24),
          rows: s.rows.slice(0, 10).map(r => ({
            id: r.id,
            title: r.title.slice(0, 24),
            description: (r.description || '').slice(0, 72),
          })),
        })),
      },
    },
  };
}

/**
 * Image message with optional caption
 */
export function imagePayload(imageUrl, caption = '') {
  return {
    type: 'image',
    image: { link: imageUrl, caption },
  };
}

/**
 * Mark a message as read (improves UX — removes "delivered" tick)
 */
export async function markRead(messageId, env) {
  await sendWhatsAppMessage(
    null,
    { status: 'read', message_id: messageId },
    env
  ).catch(() => {}); // best-effort
}

// ─────────────────────────────────────────────────────────────
// Convenience senders
// ─────────────────────────────────────────────────────────────

export async function sendText(to, text, env) {
  return sendWhatsAppMessage(to, textPayload(text), env);
}

export async function sendButtons(to, body, btns, env, header, footer) {
  return sendWhatsAppMessage(to, buttonPayload(body, btns, header, footer), env);
}

export async function sendList(to, body, btnLabel, sections, env) {
  return sendWhatsAppMessage(to, listPayload(body, btnLabel, sections), env);
}

export async function sendImage(to, imageUrl, caption, env) {
  return sendWhatsAppMessage(to, imagePayload(imageUrl, caption), env);
}
