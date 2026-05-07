/**
 * src/paystack.js — Paystack API Client
 */

export async function initializePaystackTransaction(data, env) {
  const { amountKobo, email, reference, metadata } = data;
  const secretKey = env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    throw new Error('PAYSTACK_SECRET_KEY is not set');
  }

  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: amountKobo,
      email: email || 'customer@fastchow.bot', // Paystack requires an email
      reference,
      metadata,
      callback_url: env.PAYSTACK_CALLBACK_URL || undefined,
    }),
  });

  const result = await response.json();
  if (!response.ok) {
    console.error('[Paystack] Initialization error:', result);
    throw new Error(result.message || 'Paystack initialization failed');
  }

  return result.data; // { authorization_url, access_code, reference }
}

export async function verifyPaystackTransaction(reference, env) {
  const secretKey = env.PAYSTACK_SECRET_KEY;

  const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
    },
  });

  const result = await response.json();
  if (!response.ok) {
    console.error('[Paystack] Verification error:', result);
    throw new Error(result.message || 'Paystack verification failed');
  }

  return result.data; // { status, amount, reference, ... }
}

export async function verifyPaystackWebhookSignature(signature, body, env) {
  const secretKey = env.PAYSTACK_SECRET_KEY;
  if (!secretKey || !signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-512' }, // Paystack uses SHA-512
    false,
    ['verify']
  );

  const sigBytes = hexToBytes(signature);
  const bodyBytes = encoder.encode(body);

  return await crypto.subtle.verify('HMAC', key, sigBytes, bodyBytes);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
