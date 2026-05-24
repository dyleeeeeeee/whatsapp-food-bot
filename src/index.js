/**
 * src/index.js — Worker Entry Point
 *
 * Single Worker handles all incoming requests:
 *   GET  /webhook → Meta webhook verification challenge
 *   POST /webhook → Incoming WhatsApp messages
 *   GET  /health  → Liveness probe
 */

import { verifyWebhookSignature } from './security.js';
import { handleWebhookGet, handleWebhookPost } from './webhook.js';
import { handleFlutterwaveWebhook } from './webhooks/flutterwave_handler.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/webhook') {
        if (request.method === 'GET') {
          return handleWebhookGet(request, env);
        }

        if (request.method === 'POST') {
          const rawBody = await request.text();
          const valid   = await verifyWebhookSignature(request, rawBody, env);
          if (!valid) {
            return new Response('Forbidden', { status: 403 });
          }

          const body = JSON.parse(rawBody);
          // ctx.waitUntil returns 200 immediately; processing runs asynchronously.
          // Meta requires a 200 within 20s or it will retry — deduplication in
          // handleWebhookPost prevents duplicate processing on retries.
          ctx.waitUntil(handleWebhookPost(body, env));
          return new Response('OK', { status: 200 });
        }
      }

      if (url.pathname === '/flutterwave/webhook' && request.method === 'POST') {
        return handleFlutterwaveWebhook(request, env, ctx);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('[Worker] Unhandled error:', err);
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
