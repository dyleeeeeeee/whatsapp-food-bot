/**
 * src/reconcile.js — Pending-Payment Reconciliation Sweep
 *
 * BLOCKER FIX: there was no reconciliation sweep, so a payment that succeeded
 * at Flutterwave but whose webhook never arrived (dropped, timed out, retried
 * past expiry) left the order stuck on payment_status='pending' forever.
 * Abandoned/failed payments were likewise never reaped, so the pending queue
 * grew without bound.
 *
 * reconcilePendingPayments(env) is the cron entrypoint. It:
 *   1. Re-verifies recent pending orders against Flutterwave and confirms the
 *      ones that actually succeeded (mirrors the webhook's confirm path, but
 *      driven by a DB scan instead of an inbound event).
 *   2. Ages out stale pending orders (older than 1 day, not confirmed) to
 *      payment_status='failed' so the queue stays bounded.
 *
 * NEVER throws: every order is processed in its own try/catch, and a systemic
 * failure (e.g. the initial SELECT) is caught and reported via alertAdmin.
 */

import { markOrderPaidAtomic } from './db.js';
import { verifyFlutterwaveTransaction } from './payments/flutterwave.js';
import { alertAdmin } from './lib/alert.js';
import { sendText } from './whatsapp.js';

const PENDING_SCAN_LIMIT = 50;
// Amount tolerance in NGN — matches the webhook handler's float comparison.
const AMOUNT_TOLERANCE = 0.01;

export async function reconcilePendingPayments(env) {
  const summary = { scanned: 0, confirmed: 0, aged_out: 0, mismatched: 0, errors: 0 };

  let rows;
  try {
    const result = await env.DB.prepare(
      `SELECT id, payment_reference, total_price
         FROM Orders
        WHERE payment_status = 'pending'
          AND payment_reference IS NOT NULL
          AND created_at > datetime('now', '-2 days')
        ORDER BY created_at ASC
        LIMIT ?`
    ).bind(PENDING_SCAN_LIMIT).all();
    rows = result.results || [];
  } catch (err) {
    // Systemic failure — the sweep could not even read its work queue.
    console.error('[Reconcile] CRITICAL: pending scan failed:', err);
    await alertAdmin(env, 'reconcile_scan_failed', String(err && err.message || err));
    return summary;
  }

  summary.scanned = rows.length;

  for (const order of rows) {
    try {
      const verified = await verifyFlutterwaveTransaction(order.payment_reference, env);

      const isSuccess =
        verified &&
        verified.status === 'successful' &&
        verified.currency === 'NGN' &&
        typeof verified.amount === 'number' &&
        Math.abs(verified.amount - order.total_price) <= AMOUNT_TOLERANCE;

      if (isSuccess) {
        const { changed } = await markOrderPaidAtomic(
          order.id,
          new Date().toISOString(),
          env
        );
        if (changed) {
          summary.confirmed++;
          // Best-effort customer notification — never let a failed send abort
          // the sweep or block other orders.
          try {
            const phone = await orderPhone(order.id, env);
            if (phone) {
              await sendText(
                phone,
                `✅ *Payment Received!*\n\nThanks! Your payment for order #${order.id} has been confirmed. We're now getting your food ready!`,
                env
              );
            }
          } catch (notifyErr) {
            console.error(`[Reconcile] notify failed for order #${order.id}:`, notifyErr);
          }
        }
        continue;
      }

      // Verified as successful but the money doesn't match this order — a real
      // discrepancy that needs a human. Alert, but do NOT mark paid.
      if (verified && verified.status === 'successful') {
        summary.mismatched++;
        await alertAdmin(
          env,
          'reconcile_amount_mismatch',
          `order #${order.id}: expected ${order.total_price} NGN, ` +
          `got ${verified.amount} ${verified.currency}`
        );
      }
      // Otherwise the tx is still pending/failed at Flutterwave — the age-out
      // pass below handles long-stale orders.
    } catch (err) {
      // Per-order isolation: a verify failure on one order must not stop the
      // rest of the sweep.
      summary.errors++;
      console.error(`[Reconcile] order #${order.id} verify failed:`, err);
    }
  }

  // Age out: pending orders older than 1 day that never got confirmed above.
  // markOrderPaidAtomic ran first, so anything still 'pending' here is unpaid.
  try {
    const result = await env.DB.prepare(
      `UPDATE Orders
          SET payment_status = 'failed', updated_at = datetime('now')
        WHERE payment_status = 'pending'
          AND created_at < datetime('now', '-1 day')`
    ).run();
    summary.aged_out = result.meta.changes || 0;
  } catch (err) {
    console.error('[Reconcile] age-out pass failed:', err);
    await alertAdmin(env, 'reconcile_ageout_failed', String(err && err.message || err));
  }

  return summary;
}

/**
 * Fetch just the customer phone for an order — the pending scan selects only
 * id/reference/total to stay cheap, so we look the phone up lazily on the rare
 * confirm path. Returns null on any failure (best-effort).
 */
async function orderPhone(orderId, env) {
  try {
    const row = await env.DB.prepare(
      `SELECT user_phone FROM Orders WHERE id = ?`
    ).bind(orderId).first();
    return row ? row.user_phone : null;
  } catch {
    return null;
  }
}
