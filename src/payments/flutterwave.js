/**
 * src/payments/flutterwave.js — Flutterwave API Client
 *
 * Direct REST API implementation (no SDK) for Cloudflare Workers.
 * Implements Standard Checkout flow for payment processing.
 */

export async function initializeFlutterwaveTransaction(data, env) {
  const { amount, txRef, currency, customer, metadata } = data;
  const secretKey = env.FLUTTERWAVE_SECRET_KEY;

  if (!secretKey) {
    throw new Error('FLUTTERWAVE_SECRET_KEY is not set');
  }

  // BUG-08: tx_ref is always caller-provided so the reference can be
  // persisted to D1 BEFORE this init call.
  if (!txRef) {
    throw new Error('initializeFlutterwaveTransaction: txRef is required');
  }

  // BUG-03: never send a non-positive or below-minimum charge to Flutterwave.
  // Flutterwave's minimum collectable amount is 100 NGN.
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`initializeFlutterwaveTransaction: amount must be > 0 (got ${amount})`);
  }
  if (amount < 100) {
    throw new Error(`initializeFlutterwaveTransaction: amount must be >= 100 NGN (got ${amount})`);
  }

  const response = await fetch('https://api.flutterwave.com/v3/payments', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tx_ref: txRef,
      amount: amount,
      currency: currency || 'NGN',
      redirect_url: env.FLUTTERWAVE_CALLBACK_URL || 'https://flutterwave.com/pay',
      customer: {
        email: customer.email || 'customer@fastchow.bot',
        phone_number: customer.phone_number,
        name: customer.name || 'Customer'
      },
      customizations: {
        title: 'Food Order Payment',
        description: `Order payment via FastChow`,
        logo: ''
      },
      payment_options: 'card,mobilemoneyghana,mpesa,ussd',
      meta: metadata || {}
    }),
  });

  const result = await response.json();
  if (!response.ok || result.status !== 'success') {
    console.error('[Flutterwave] Initialization error:', result);
    throw new Error(result.message || 'Flutterwave initialization failed');
  }

  return result.data; // { link: "checkout URL", ... }
}

export async function verifyFlutterwaveTransaction(txRef, env) {
  const secretKey = env.FLUTTERWAVE_SECRET_KEY;

  const response = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
    },
  });

  const result = await response.json();
  if (!response.ok || result.status !== 'success') {
    console.error('[Flutterwave] Verification error:', result);
    throw new Error(result.message || 'Flutterwave verification failed');
  }

  return result.data; // { status: "successful", amount, tx_ref, ... }
}

export async function verifyFlutterwaveWebhookSignature(signature, env) {
  const webhookSecret = env.FLUTTERWAVE_WEBHOOK_SECRET || '';

  // BUG-06 FIX: hard fail when the secret is missing/empty. A blank secret
  // previously meant "skip verification", which left the webhook open to
  // forgery by anyone who knew the endpoint URL.
  if (!webhookSecret) {
    console.error('[Flutterwave] FATAL: FLUTTERWAVE_WEBHOOK_SECRET is not set. Rejecting webhook.');
    return false;
  }

  if (typeof signature !== 'string' || signature.length === 0) return false;

  return constantTimeEqual(signature, webhookSecret);
}

/**
 * Constant-time string comparison to avoid leaking the secret via timing.
 * Compares byte-by-byte over the max length so the loop count does not
 * depend on where the first mismatch occurs.
 */
function constantTimeEqual(a, b) {
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
