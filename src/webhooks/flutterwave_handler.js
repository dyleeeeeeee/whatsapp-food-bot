/**
 * src/webhooks/flutterwave_handler.js — Flutterwave Webhook Logic
 *
 * Handles payment confirmation webhooks from Flutterwave.
 * Mirrors paystack_handler.js structure with Flutterwave-specific differences.
 */

import { verifyFlutterwaveWebhookSignature, verifyFlutterwaveTransaction } from '../payments/flutterwave.js';
import { getOrderByReference, updateOrderPayment } from '../db.js';
import { sendText } from '../whatsapp.js';

export async function handleFlutterwaveWebhook(request, env, ctx) {
  const signature = request.headers.get('verif-hash');
  const rawBody = await request.text();

  const isValid = await verifyFlutterwaveWebhookSignature(signature, env);
  if (!isValid) {
    console.error('[Flutterwave] Invalid webhook signature');
    return new Response('Invalid Signature', { status: 401 });
  }

  const body = JSON.parse(rawBody);
  const event = body.event;

  // Flutterwave event name: charge.completed (not charge.success)
  if (event === 'charge.completed') {
    const data = body.data;
    const txRef = data.tx_ref;
    const amount = data.amount;
    const status = data.status;

    // Use ctx.waitUntil to process asynchronously and return 200 to Flutterwave immediately
    ctx.waitUntil(processPaymentSuccess(txRef, amount, status, env));
  }

  return new Response('OK', { status: 200 });
}

async function processPaymentSuccess(txRef, amount, status, env) {
  try {
    // 1. Find the order by tx_ref (stored as payment_reference)
    const order = await getOrderByReference(txRef, env);
    if (!order) {
      console.error(`[Flutterwave] Order not found for tx_ref: ${txRef}`);
      return;
    }

    // 2. Ignore if already paid (idempotency)
    if (order.payment_status === 'paid') {
      console.log(`[Flutterwave] Order #${order.id} already marked as paid.`);
      return;
    }

    // 3. Verify with Flutterwave API (Defense-in-depth)
    const verifiedData = await verifyFlutterwaveTransaction(txRef, env);

    // Flutterwave status: "successful" (not "success")
    if (verifiedData.status !== 'successful' || verifiedData.amount !== amount) {
      console.error(`[Flutterwave] Verification failed for order #${order.id}. Expected successful and ${amount}, got ${verifiedData.status} and ${verifiedData.amount}`);
      return;
    }

    // 4. Confirm amount matches D1 order total
    // Flutterwave uses direct float amount (not kobo like Paystack)
    const expectedAmount = order.total_price;
    if (Math.abs(amount - expectedAmount) > 0.01) {
      console.error(`[Flutterwave] CRITICAL: Amount mismatch for order #${order.id}. Expected ${expectedAmount}, got ${amount}`);
      await updateOrderPayment(order.id, { payment_status: 'failed' }, env);
      await sendText(order.user_phone, `⚠️ We received a payment for order #${order.id}, but the amount was incorrect. Our team will contact you shortly.`, env);
      return;
    }

    // 5. Mark as paid
    await updateOrderPayment(order.id, {
      payment_status: 'paid',
      paid_at: new Date().toISOString()
    }, env);

    // 6. Notify customer
    await sendText(
      order.user_phone,
      `✅ *Payment Received!*\n\nThanks! Your payment for order #${order.id} has been confirmed. We're now getting your food ready!`,
      env
    );

    console.log(`[Flutterwave] Order #${order.id} successfully marked as paid.`);
  } catch (err) {
    console.error('[Flutterwave] Error processing payment success:', err);
  }
}
