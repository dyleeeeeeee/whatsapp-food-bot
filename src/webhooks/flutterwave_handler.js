/**
 * src/webhooks/flutterwave_handler.js — Flutterwave Webhook Logic
 *
 * Handles payment confirmation webhooks from Flutterwave: verifies the
 * signature, matches the unpaid order by tx_ref, and confirms payment exactly
 * once (atomic, idempotent) before notifying the customer.
 */

import { verifyFlutterwaveWebhookSignature, verifyFlutterwaveTransaction } from '../payments/flutterwave.js';
import { getOrderByReference, updateOrderPayment, markOrderPaidAtomic, persistTransactionId, logRefund } from '../db.js';
import { sendText } from '../whatsapp.js';
import { alertAdmin } from '../lib/alert.js';

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
    const txId = data.id; // Flutterwave transaction id

    // Use ctx.waitUntil to process asynchronously and return 200 to Flutterwave immediately
    ctx.waitUntil(processPaymentSuccess(txRef, amount, status, txId, env));
  } else {
    // Dispute / refund / chargeback (or any non-charge event): never silently
    // 200 away money-affecting events. Log + alert so a human can reconcile.
    ctx.waitUntil(processNonChargeEvent(event, body.data, env));
  }

  return new Response('OK', { status: 200 });
}

/**
 * Handle dispute / refund / chargeback (any event !== 'charge.completed').
 * Records the event in RefundLog (graceful if the table is absent) and alerts
 * the admin — we do NOT silently acknowledge money-affecting events.
 */
async function processNonChargeEvent(event, data, env) {
  try {
    const txRef = data && data.tx_ref;
    const txId = data && data.id;
    const amount = data && data.amount;
    const status = (data && data.status) || event;

    let orderId = null;
    if (txRef) {
      try {
        const order = await getOrderByReference(txRef, env);
        orderId = order ? order.id : null;
      } catch (err) {
        console.error('[Flutterwave] Lookup failed for non-charge event:', err);
      }
    }

    console.warn(`[Flutterwave] Non-charge event '${event}' (tx_ref=${txRef}, txId=${txId}, order #${orderId})`);
    await logRefund(env, { orderId, txId, amount, status: event });
    await alertAdmin(env, 'flutterwave_dispute', {
      event,
      txRef,
      txId,
      amount,
      orderId,
      status,
    });
  } catch (err) {
    console.error('[Flutterwave] Error handling non-charge event:', err);
  }
}

async function processPaymentSuccess(txRef, amount, status, txId, env) {
  try {
    // 1. Find the order by tx_ref (stored as payment_reference)
    const order = await getOrderByReference(txRef, env);
    if (!order) {
      console.error(`[Flutterwave] Order not found for tx_ref: ${txRef}`);
      await alertAdmin(env, 'flutterwave_order_not_found', { txRef, txId, amount });
      return;
    }

    // 2. Ignore if already paid (idempotency)
    if (order.payment_status === 'paid') {
      console.log(`[Flutterwave] Order #${order.id} already marked as paid.`);
      return;
    }

    // 3. Verify with Flutterwave API (Defense-in-depth)
    const verifiedData = await verifyFlutterwaveTransaction(txRef, env);

    // Flutterwave status: "successful" (not "success"). Compare amounts with a
    // float tolerance — never strict !== on floats.
    if (verifiedData.status !== 'successful' || Math.abs(verifiedData.amount - amount) > 0.01) {
      console.error(`[Flutterwave] Verification failed for order #${order.id}. Expected successful and ${amount}, got ${verifiedData.status} and ${verifiedData.amount}`);
      return;
    }

    // 3b. Defense in depth: only NGN is accepted. A non-NGN settlement with a
    // matching numeric amount must never mark an order paid.
    if (verifiedData.currency !== 'NGN') {
      console.error(`[Flutterwave] CRITICAL: Non-NGN currency for order #${order.id}: ${verifiedData.currency}`);
      await alertAdmin(env, 'flutterwave_currency_mismatch', {
        orderId: order.id,
        txRef,
        txId: verifiedData.id ?? txId,
        currency: verifiedData.currency,
        amount,
      });
      return;
    }

    // 4. Confirm amount matches D1 order total
    // Flutterwave uses a direct float amount (NGN), not minor units
    const expectedAmount = order.total_price;
    if (Math.abs(amount - expectedAmount) > 0.01) {
      console.error(`[Flutterwave] CRITICAL: Amount mismatch for order #${order.id}. Expected ${expectedAmount}, got ${amount}`);
      await updateOrderPayment(order.id, { payment_status: 'failed' }, env);
      await alertAdmin(env, 'flutterwave_amount_mismatch', {
        orderId: order.id,
        txRef,
        txId: verifiedData.id ?? txId,
        expected: expectedAmount,
        got: amount,
      });
      await sendText(order.user_phone, `⚠️ We received a payment for order #${order.id}, but the amount was incorrect. Our team will contact you shortly.`, env);
      return;
    }

    // 5. Atomically mark as paid. The DB guard (payment_status != 'paid')
    // makes this idempotent: a duplicate webhook flips no row, so { changed }
    // is only true for the single delivery that actually marked it paid.
    const { changed } = await markOrderPaidAtomic(order.id, new Date().toISOString(), env);
    if (!changed) {
      console.log(`[Flutterwave] Order #${order.id} already paid; skipping duplicate confirmation.`);
      return;
    }

    // 5b. Persist the Flutterwave transaction id for reconciliation / refunds.
    // Best-effort: a failure here must not block the customer notification.
    try {
      await persistTransactionId(order.id, verifiedData.id ?? txId, env);
    } catch (err) {
      console.error(`[Flutterwave] Failed to persist transaction id for order #${order.id}:`, err);
    }

    // 6. Notify customer — only on the delivery that actually changed the row.
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
