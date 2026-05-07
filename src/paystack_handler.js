/**
 * src/paystack_handler.js — Paystack Webhook Logic
 */

import { verifyPaystackWebhookSignature, verifyPaystackTransaction } from './paystack.js';
import { getOrderByReference, updateOrderPayment } from './db.js';
import { sendText } from './whatsapp.js';

export async function handlePaystackWebhook(request, env, ctx) {
  const signature = request.headers.get('x-paystack-signature');
  const rawBody = await request.text();

  const isValid = await verifyPaystackWebhookSignature(signature, rawBody, env);
  if (!isValid) {
    console.error('[Paystack] Invalid webhook signature');
    return new Response('Invalid Signature', { status: 401 });
  }

  const body = JSON.parse(rawBody);
  const event = body.event;

  if (event === 'charge.success') {
    const data = body.data;
    const reference = data.reference;
    const amountKobo = data.amount;

    // Use ctx.waitUntil to process asynchronously and return 200 to Paystack immediately
    ctx.waitUntil(processPaymentSuccess(reference, amountKobo, env));
  }

  return new Response('OK', { status: 200 });
}

async function processPaymentSuccess(reference, amountKobo, env) {
  try {
    // 1. Find the order
    const order = await getOrderByReference(reference, env);
    if (!order) {
      console.error(`[Paystack] Order not found for reference: ${reference}`);
      return;
    }

    // 2. Ignore if already paid
    if (order.payment_status === 'paid') {
      console.log(`[Paystack] Order #${order.id} already marked as paid.`);
      return;
    }

    // 3. Verify with Paystack API (Defense-in-depth)
    const verifiedData = await verifyPaystackTransaction(reference, env);
    if (verifiedData.status !== 'success' || verifiedData.amount !== amountKobo) {
      console.error(`[Paystack] Verification failed for order #${order.id}. Expected success and ${amountKobo}, got ${verifiedData.status} and ${verifiedData.amount}`);
      return;
    }

    // 4. Confirm amount matches D1 order total
    const expectedKobo = Math.round(order.total_price * 100);
    if (amountKobo !== expectedKobo) {
      console.error(`[Paystack] CRITICAL: Amount mismatch for order #${order.id}. Expected ${expectedKobo}, got ${amountKobo}`);
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

    console.log(`[Paystack] Order #${order.id} successfully marked as paid.`);
  } catch (err) {
    console.error('[Paystack] Error processing payment success:', err);
  }
}
