/**
 * src/security.js — Webhook Signature Verification
 *
 * Meta signs every POST with HMAC-SHA256 using your App Secret.
 * We verify this before processing any payload.
 */

/**
 * Verify Meta's X-Hub-Signature-256 header.
 * Returns true if valid, false otherwise.
 */
export async function verifyWebhookSignature(request, rawBody, env) {
  // In staging/dev you may want to skip verification
  if (env.ENVIRONMENT === 'development') return true;

  const signature = request.headers.get('X-Hub-Signature-256');
  if (!signature) return false;

  const secret = env.WHATSAPP_APP_SECRET;
  if (!secret) {
    console.warn('[Security] WHATSAPP_APP_SECRET not set — skipping sig check');
    return true;
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

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Sanitize a string input — strip control chars, limit length.
 */
export function sanitize(input, maxLen = 500) {
  if (typeof input !== 'string') return '';
  return input.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maxLen);
}

/**
 * Check if a phone number is an admin.
 */
export async function isAdmin(phone, env) {
  const row = await env.DB.prepare(
    'SELECT phone_number FROM AdminUsers WHERE phone_number = ?'
  )
    .bind(phone)
    .first();
  return !!row;
}
