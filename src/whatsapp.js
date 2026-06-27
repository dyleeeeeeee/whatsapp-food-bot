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

import { fetchWithRetry } from './lib/http.js';



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



  // Route through fetchWithRetry so a transient 5xx/429/network error
  // retries with backoff instead of hard-failing. The throw-on-final-
  // failure contract is preserved: we still throw, but only after retries
  // are exhausted (fetchWithRetry returns the final Response / rethrows the
  // last network error). Callers depend on this throw, so keep it intact.
  const res = await fetchWithRetry(url, {

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
 *
 * BUG-21 FIX: WhatsApp caps the TOTAL number of rows at 10 across ALL
 * sections (NOT 10 per section). We flatten-count rows and keep only the
 * first 10 across sections, preserving section grouping. Sections that end
 * up empty after the cap are dropped. We console.warn how many rows were
 * dropped so callers can paginate.
 *
 * @param {string} bodyText  - Body text
 * @param {string} btnLabel  - Button label (≤ 20 chars)
 * @param {Array}  sections  - [{ title, rows: [{ id, title, description }] }]
 */

export function listPayload(bodyText, btnLabel, sections) {

  const MAX_TOTAL_ROWS = 10;
  let remaining = MAX_TOTAL_ROWS;
  let droppedRows = 0;

  const cappedSections = [];
  for (const s of (sections || []).slice(0, 10)) {
    const allRows = s.rows || [];
    const kept = remaining > 0 ? allRows.slice(0, remaining) : [];
    droppedRows += allRows.length - kept.length;
    remaining -= kept.length;

    // Drop sections that have no rows left after the global cap.
    if (kept.length === 0) continue;

    cappedSections.push({
      title: String(s.title).slice(0, 24),
      rows: kept.map(r => ({
        id:          String(r.id).slice(0, 256),
        title:       String(r.title).slice(0, 24),
        description: String(r.description || '').slice(0, 72),
      })),
    });
  }

  if (droppedRows > 0) {
    console.warn(`[WhatsApp] listPayload: dropped ${droppedRows} row(s) to enforce 10-row total cap`);
  }

  return {

    type: 'interactive',

    interactive: {

      type: 'list',

      body: { text: bodyText },

      action: {

        button: String(btnLabel).slice(0, 20),

        sections: cappedSections,

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
 * Interactive CTA URL message (UX-01).
 * Renders a body with a single tappable button that opens a URL.
 *
 * @param {string}      bodyText   - Message body
 * @param {string}      buttonText - Button display text
 * @param {string}      url        - HTTPS URL the button opens
 * @param {string|null} header     - Optional header text (≤ 60 chars)
 * @param {string|null} footer     - Optional footer text (≤ 60 chars)
 */
export function ctaUrlPayload(bodyText, buttonText, url, header = null, footer = null) {
  const msg = {
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: bodyText },
      action: {
        name: 'cta_url',
        parameters: {
          display_text: String(buttonText).slice(0, 20),
          url,
        },
      },
    },
  };
  if (header) msg.interactive.header = { type: 'text', text: String(header).slice(0, 60) };
  if (footer) msg.interactive.footer = { text: String(footer).slice(0, 60) };
  return msg;
}

/**
 * Interactive location-request message (UX-02).
 * Prompts the user to share their location via a native button.
 *
 * @param {string} bodyText - Message body
 */
export function locationRequestPayload(bodyText) {
  return {
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: bodyText },
      action: {
        name: 'send_location',
      },
    },
  };
}

/**
 * Interactive WhatsApp Flow message (UX-04).
 * Launches a hosted Flow (e.g. checkout / add-item form).
 *
 * @param {string}      bodyText - Message body
 * @param {object}      opts     - { flowId, flowToken, flowCta, screenId, data }
 * @param {string|null} footer   - Optional footer text (≤ 60 chars)
 */
export function flowPayload(bodyText, { flowId, flowToken, flowCta, screenId, data }, footer = null) {
  // WhatsApp rejects an empty `data` object on a screen that declares no data
  // model — include `data` only when there is actually something to pass.
  const actionPayload = { screen: screenId };
  if (data && typeof data === 'object' && Object.keys(data).length > 0) {
    actionPayload.data = data;
  }
  const msg = {
    type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: bodyText },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: flowToken,
          flow_id: flowId,
          flow_cta: flowCta,
          flow_action: 'navigate',
          flow_action_payload: actionPayload,
        },
      },
    },
  };
  if (footer) msg.interactive.footer = { text: String(footer).slice(0, 60) };
  return msg;
}

/**
 * Template message (UX-09).
 * Sends a pre-approved WhatsApp message template.
 *
 * @param {string} name         - Template name
 * @param {string} languageCode - BCP-47 language code (e.g. 'en_US')
 * @param {Array}  components    - Template components array
 */
export function templatePayload(name, languageCode, components) {
  return {
    type: 'template',
    template: {
      name,
      language: { code: languageCode },
      components: components || [],
    },
  };
}

/**

 * Mark a message as read.

 * Uses the same /messages endpoint with a status payload (no `to` field).

 */

export async function markRead(messageId, env) {

  const url = `${graphBase(env)}/${env.PHONE_NUMBER_ID}/messages`;

  try {

    await fetchWithRetry(url, {

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



/**
 * Mark a message as read AND show a typing indicator (UX-06).
 * Reuses the same /messages 'read' endpoint as markRead, adding the
 * typing_indicator field. Best-effort — NEVER throws.
 *
 * @param {string} to        - Recipient phone (unused by API; kept for caller ergonomics)
 * @param {string} messageId - The inbound message ID to mark read
 * @param {object} env       - Worker env bindings
 */
export async function sendTypingIndicator(to, messageId, env) {
  const url = `${graphBase(env)}/${env.PHONE_NUMBER_ID}/messages`;
  try {
    await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      }),
    });
  } catch {
    // best-effort — never throw on typing indicators
  }
}



// ─────────────────────────────────────────────────────────────

// Convenience senders

// ─────────────────────────────────────────────────────────────



export async function sendText(to, text, env) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    console.error('[WhatsApp] sendText: body text is empty');
    throw new Error('sendText: body text is empty');
  }
  if (text.length > 1024) {
    console.error('[WhatsApp] sendText: body text exceeds 1024 chars, splitting into chunks');
    // Split into chunks of 1024 chars, trying to break at word boundaries
    const chunks = [];
    let current = '';
    const words = text.split(/\s+/);
    for (const word of words) {
      if ((current + ' ' + word).length > 1024) {
        if (current) chunks.push(current.trim());
        current = word;
      } else {
        current += (current ? ' ' : '') + word;
      }
    }
    if (current) chunks.push(current.trim());
    // Send all chunks sequentially
    for (const chunk of chunks) {
      await sendWhatsAppMessage(to, textPayload(chunk), env);
    }
    return;
  }
  return sendWhatsAppMessage(to, textPayload(text), env);

}



export async function sendButtons(to, bodyText, btns, env, header, footer) {
  if (!bodyText || typeof bodyText !== 'string' || bodyText.trim().length === 0) {
    console.error('[WhatsApp] sendButtons: body text is empty');
    throw new Error('sendButtons: body text is empty');
  }
  if (bodyText.length > 1024) {
    console.error('[WhatsApp] sendButtons: body text exceeds 1024 chars');
    bodyText = bodyText.slice(0, 1024);
  }
  return sendWhatsAppMessage(to, buttonPayload(bodyText, btns, header, footer), env);

}



export async function sendList(to, bodyText, btnLabel, sections, env) {
  if (!bodyText || typeof bodyText !== 'string' || bodyText.trim().length === 0) {
    console.error('[WhatsApp] sendList: body text is empty');
    throw new Error('sendList: body text is empty');
  }
  if (bodyText.length > 1024) {
    console.error('[WhatsApp] sendList: body text exceeds 1024 chars');
    bodyText = bodyText.slice(0, 1024);
  }
  return sendWhatsAppMessage(to, listPayload(bodyText, btnLabel, sections), env);

}



export async function sendImageButtons(to, bodyText, btns, imageUrl, env, footer) {
  if (!bodyText || typeof bodyText !== 'string' || bodyText.trim().length === 0) {
    console.error('[WhatsApp] sendImageButtons: body text is empty');
    throw new Error('sendImageButtons: body text is empty');
  }
  if (bodyText.length > 1024) {
    console.error('[WhatsApp] sendImageButtons: body text exceeds 1024 chars');
    bodyText = bodyText.slice(0, 1024);
  }
  return sendWhatsAppMessage(to, imageButtonPayload(bodyText, btns, imageUrl, footer), env);
}



export async function sendImage(to, imageUrl, caption, env) {
  if (caption && typeof caption === 'string' && caption.length > 1024) {
    console.error('[WhatsApp] sendImage: caption exceeds 1024 chars');
    caption = caption.slice(0, 1024);
  }
  return sendWhatsAppMessage(to, imagePayload(imageUrl, caption), env);
}



export async function sendCtaUrl(to, bodyText, buttonText, url, env, footer = null) {
  if (!bodyText || typeof bodyText !== 'string' || bodyText.trim().length === 0) {
    console.error('[WhatsApp] sendCtaUrl: body text is empty');
    throw new Error('sendCtaUrl: body text is empty');
  }
  if (bodyText.length > 1024) {
    console.error('[WhatsApp] sendCtaUrl: body text exceeds 1024 chars');
    bodyText = bodyText.slice(0, 1024);
  }
  return sendWhatsAppMessage(to, ctaUrlPayload(bodyText, buttonText, url, null, footer), env);
}



export async function sendLocationRequest(to, bodyText, env) {
  if (!bodyText || typeof bodyText !== 'string' || bodyText.trim().length === 0) {
    console.error('[WhatsApp] sendLocationRequest: body text is empty');
    throw new Error('sendLocationRequest: body text is empty');
  }
  if (bodyText.length > 1024) {
    console.error('[WhatsApp] sendLocationRequest: body text exceeds 1024 chars');
    bodyText = bodyText.slice(0, 1024);
  }
  return sendWhatsAppMessage(to, locationRequestPayload(bodyText), env);
}



export async function sendFlow(to, bodyText, opts, env) {
  if (!bodyText || typeof bodyText !== 'string' || bodyText.trim().length === 0) {
    console.error('[WhatsApp] sendFlow: body text is empty');
    throw new Error('sendFlow: body text is empty');
  }
  if (bodyText.length > 1024) {
    console.error('[WhatsApp] sendFlow: body text exceeds 1024 chars');
    bodyText = bodyText.slice(0, 1024);
  }
  return sendWhatsAppMessage(to, flowPayload(bodyText, opts), env);
}



export async function sendTemplate(to, name, languageCode, components, env) {
  return sendWhatsAppMessage(to, templatePayload(name, languageCode, components), env);
}



// ─────────────────────────────────────────────────────────────

// Phone number registration

// ─────────────────────────────────────────────────────────────



/**

 * Register a phone number to the WhatsApp Cloud API.

 * This activates the phone number and sets up two-step verification.

 *

 * @param {string} pin - 6-digit PIN for two-step verification

 * @param {object} env - Worker env bindings (PHONE_NUMBER_ID, WHATSAPP_TOKEN)

 * @returns {Promise<{success: boolean}>}

 */

export async function registerPhoneNumber(pin, env) {

  const url = `${graphBase(env)}/${env.PHONE_NUMBER_ID}/register`;



  const res = await fetch(url, {

    method: 'POST',

    headers: {

      'Content-Type': 'application/json',

      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,

    },

    body: JSON.stringify({

      messaging_product: 'whatsapp',

      pin: String(pin).slice(0, 6),

    }),

  });



  if (!res.ok) {

    const errText = await res.text();

    console.error('[WhatsApp] Registration error:', res.status, errText);

    throw new Error(`WhatsApp registration error: ${res.status}`);

  }



  return res.json();

}



/**

 * Subscribe the app to a WhatsApp Business Account (WABA) to receive webhooks.

 * This is REQUIRED after phone number registration — without it, no message webhooks arrive.

 *

 * @param {string} wabaId - WhatsApp Business Account ID

 * @param {object} env - Worker env bindings (WHATSAPP_TOKEN)

 * @returns {Promise<{success: boolean}>}

 */

export async function subscribeAppToWABA(wabaId, env) {

  const url = `${graphBase(env)}/${wabaId}/subscribed_apps`;



  const res = await fetch(url, {

    method: 'POST',

    headers: {

      'Content-Type': 'application/json',

      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,

    },

  });



  if (!res.ok) {

    const errText = await res.text();

    console.error('[WhatsApp] WABA subscription error:', res.status, errText);

    throw new Error(`WABA subscription error: ${res.status}`);

  }



  return res.json();

}

