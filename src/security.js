/**
 * src/security.js — Webhook Signature Verification & Auth
 *
 * BUG-02: Missing APP_SECRET now hard-fails rather than bypassing security.
 * BUG-23: isAdmin KV operations wrapped with fallback to DB on KV outage.
 */

/**
 * Verify Meta's X-Hub-Signature-256 header.
 * Returns true only if signature is cryptographically valid.
 */
export async function verifyWebhookSignature(request, rawBody, env) {
  // Development bypass — explicit opt-in only
  if (env.ENVIRONMENT === 'development') return true;

  const signature = request.headers.get('X-Hub-Signature-256');
  if (!signature) return false;

  const secret = env.WHATSAPP_APP_SECRET;
  if (!secret) {
    // BUG-02 FIX: Hard fail. A missing secret means config is broken.
    // Returning true here would open the webhook to forgery by anyone.
    console.error('[Security] FATAL: WHATSAPP_APP_SECRET is not set. Rejecting all requests.');
    return false;
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBytes = hexToBytes(signature.replace('sha256=', ''));
    const bodyBytes = encoder.encode(rawBody);

    return await crypto.subtle.verify('HMAC', key, sigBytes, bodyBytes);
  } catch (err) {
    console.error('[Security] Signature verification error:', err);
    return false;
  }
}

/**
 * Convert hex string to Uint8Array.
 * Odd-length input returns empty array so verification fails safely.
 */
function hexToBytes(hex) {
  if (hex.length % 2 !== 0) return new Uint8Array(0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Sanitize a string input.
 * Strips ASCII + Unicode control characters, trims, limits length.
 */
export function sanitize(input, maxLen = 500) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\x00-\x1F\x7F\u0085\u2028\u2029]/g, '')
    .trim()
    .slice(0, maxLen);
}

/**
 * Validate that a URL is HTTPS. Used for image URL inputs.
 * BUG-10 support: centralised validation used by admin handler.
 */
export function isValidHttpsUrl(str) {
  if (!str) return false;
  try {
    const u = new URL(str);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Check if a phone number is registered as admin.
 *
 * BUG-23 FIX: KV read/write failures fall back to D1 gracefully.
 * Result cached in KV for 60 seconds — short enough to reflect
 * revoked admins quickly, long enough to eliminate per-message D1 reads.
 */
export async function isAdmin(phone, env) {
  const cacheKey = `admin:${phone}`;

  // Check KV cache first — wrap in try/catch for KV outage resilience
  try {
    const cached = await env.SESSION_KV.get(cacheKey);
    if (cached !== null) return cached === '1';
  } catch (err) {
    // KV unavailable — log and fall through to DB
    console.warn('[Security] KV unavailable for admin check, falling through to DB:', err);
  }

  const row = await env.DB.prepare(
    'SELECT phone_number FROM AdminUsers WHERE phone_number = ?'
  )
    .bind(phone)
    .first();

  const result = !!row;

  // Best-effort cache write — never block or throw on failure
  env.SESSION_KV
    .put(cacheKey, result ? '1' : '0', { expirationTtl: 60 })
    .catch(err => console.warn('[Security] Failed to cache admin status:', err));

  return result;
}
