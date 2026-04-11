/**
 * src/index.js — Worker Entry Point
 *
 * Single Worker handles all incoming requests:
 *   GET  /webhook  → Meta webhook verification challenge
 *   POST /webhook  → Incoming WhatsApp messages
 */

import { verifyWebhookSignature } from './security.js';
import { handleWebhookGet, handleWebhookPost } from './webhook.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      // ── Health check ────────────────────────────────────────
      if (url.pathname === '/health') {
        return json({ status: 'ok', ts: Date.now() });
      }

      // ── Webhook routes ──────────────────────────────────────
      if (url.pathname === '/webhook') {
        if (request.method === 'GET') {
          return handleWebhookGet(request, env);
        }

        if (request.method === 'POST') {
          // Verify Meta signature before processing
          const rawBody = await request.text();
          const valid = await verifyWebhookSignature(request, rawBody, env);
          if (!valid) {
            return new Response('Forbidden', { status: 403 });
          }
          // ctx.waitUntil keeps the Worker alive after we return 200
          const body = JSON.parse(rawBody);
          ctx.waitUntil(handleWebhookPost(body, env));
          return new Response('OK', { status: 200 });
        }
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('[Worker]', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
