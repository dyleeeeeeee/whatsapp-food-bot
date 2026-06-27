/**
 * src/index.js — Worker Entry Point
 *
 * Single Worker handles all incoming requests:
 *   GET  /webhook            → Meta webhook verification challenge
 *   POST /webhook            → Incoming WhatsApp messages
 *   POST /flutterwave/webhook → Flutterwave payment notifications
 *   GET  /health             → cheap liveness probe (always 200)
 *   GET  /health?deep=1      → deep readiness probe (D1 + KV, 503 on failure)
 *   GET  /stats              → admin metrics (gated by ADMIN_API_KEY, optional)
 *
 * scheduled() is the cron entrypoint that drives the pending-payment
 * reconciliation sweep (src/reconcile.js).
 */

import { verifyWebhookSignature } from './security.js';
import { handleWebhookGet, handleWebhookPost } from './webhook.js';
import { handleFlutterwaveWebhook } from './webhooks/flutterwave_handler.js';
import { reconcilePendingPayments } from './reconcile.js';
import { getStats } from './db.js';

// Reject webhook bodies larger than this BEFORE parsing — a malicious or
// runaway POST could otherwise force us to buffer an arbitrarily large body.
// 64 KiB is comfortably above any legitimate WhatsApp webhook payload.
const MAX_WEBHOOK_BODY_BYTES = 65536;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/health') {
        // Deep probe: actually touch D1 + KV so an orchestrator can tell the
        // difference between "process is up" and "dependencies are reachable".
        if (url.searchParams.get('deep') === '1') {
          return handleDeepHealth(env);
        }
        // Cheap liveness — no I/O, always 200.
        return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/stats') {
        return handleStats(request, env);
      }

      if (url.pathname === '/webhook') {
        if (request.method === 'GET') {
          return handleWebhookGet(request, env);
        }

        if (request.method === 'POST') {
          // Body-size guard: reject oversized payloads before buffering/parsing.
          const tooBig = bodyTooBig(request);
          if (tooBig) {
            return new Response('Payload Too Large', { status: 413 });
          }

          const rawBody = await request.text();
          // Defend against a missing/lying Content-Length: re-check the actual
          // buffered size before doing any JSON work.
          if (byteLength(rawBody) > MAX_WEBHOOK_BODY_BYTES) {
            return new Response('Payload Too Large', { status: 413 });
          }

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

  /**
   * Cron entrypoint (BLOCKER #1).
   *
   * Wired to the every-5-minutes cron trigger in wrangler.toml. Runs the pending-
   * payment reconciliation sweep. reconcilePendingPayments never throws, but we
   * still wrap it so a scheduled invocation can never surface an unhandled
   * rejection. ctx.waitUntil keeps the invocation alive until the sweep settles.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      reconcilePendingPayments(env)
        .then(summary => {
          console.log('[Cron] reconcile summary:', JSON.stringify(summary));
        })
        .catch(err => {
          // Defensive: reconcile is designed not to throw, but never let a
          // scheduled run reject unhandled.
          console.error('[Cron] reconcile failed:', err);
        })
    );
  },
};

/**
 * Deep health probe — verifies the Worker can actually reach its dependencies.
 *
 * Runs a trivial `SELECT 1` on D1 and a single KV get. Returns 200 only when
 * both succeed; any failure yields 503 so a load balancer / orchestrator pulls
 * this instance out of rotation. Plain /health stays a cheap 200 and never
 * touches I/O, so liveness and readiness are independently observable.
 */
async function handleDeepHealth(env) {
  const checks = { d1: false, kv: false };

  try {
    const row = await env.DB.prepare('SELECT 1 AS ok').first();
    checks.d1 = !!row && row.ok === 1;
  } catch (err) {
    console.error('[Health] D1 check failed:', err);
  }

  try {
    // A read of a (likely absent) key still exercises the KV binding end to
    // end; a null result is success, only a thrown error is a failure.
    await env.SESSION_KV.get('health:probe');
    checks.kv = true;
  } catch (err) {
    console.error('[Health] KV check failed:', err);
  }

  const ok = checks.d1 && checks.kv;
  return new Response(
    JSON.stringify({ status: ok ? 'ok' : 'degraded', checks, ts: Date.now() }),
    {
      status: ok ? 200 : 503,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Admin /stats endpoint (optional, gated).
 *
 * Feature-flagged off unless ADMIN_API_KEY is configured: with no key set the
 * endpoint stays 404 so we never expose metrics by default. When configured,
 * the request must present `Authorization: Bearer <ADMIN_API_KEY>` (constant-
 * time compared). Read-only — backed by db.getStats.
 */
async function handleStats(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const key = env.ADMIN_API_KEY;
  // No key configured → endpoint disabled. 404 keeps its existence hidden.
  if (!key) {
    return new Response('Not Found', { status: 404 });
  }

  const auth = request.headers.get('Authorization') || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!timingSafeEqual(presented, key)) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const stats = await getStats(env);
    return new Response(JSON.stringify(stats), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[Stats] getStats failed:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * Pre-read size guard from the Content-Length header. Returns true when the
 * declared body length exceeds the cap. A missing/invalid header returns false
 * here (we can't trust it) — the post-read byteLength check is the backstop.
 */
function bodyTooBig(request) {
  const len = request.headers.get('Content-Length');
  if (!len) return false;
  const n = Number(len);
  return Number.isFinite(n) && n > MAX_WEBHOOK_BODY_BYTES;
}

/** UTF-8 byte length of a string (request bodies are bytes, not chars). */
function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

/**
 * Constant-time string comparison — avoids leaking the admin key length/prefix
 * via early-exit timing. Mirrors the pattern in payments/flutterwave.js.
 */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
