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
  // If no secret configured, skip verification (set FLUTTERWAVE_WEBHOOK_SECRET to lock down)
  if (!webhookSecret) return true;
  return signature === webhookSecret;
}
