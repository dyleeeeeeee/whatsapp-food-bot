/**
 * tests/reconcile.test.mjs — pending-payment reconciliation sweep.
 *
 * Blocker: a payment that succeeded at Flutterwave but whose webhook never
 * arrived left the order stuck on payment_status='pending' forever, and
 * abandoned payments were never reaped. reconcilePendingPayments(env) must:
 *   - confirm a verified-successful, amount-matching pending order (paid),
 *   - leave a still-pending tx alone but age out long-stale ones to 'failed',
 *   - never throw (per-order try/catch).
 *
 * "Mock verify" is done by stubbing global fetch so verifyFlutterwaveTransaction
 * and sendText never touch the network — no miniflare, no real HTTP.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcilePendingPayments } from '../src/reconcile.js';
import { makeD1, makeKV, installFetch, jsonResponse } from './helpers.mjs';

// Build a fetch handler that answers Flutterwave verify-by-reference calls
// from a tx_ref -> data table, and swallows WhatsApp graph sends.
function fetchRouter(verifyByRef) {
  return (url) => {
    if (url.includes('/v3/transactions/verify_by_reference')) {
      const m = url.match(/tx_ref=([^&]+)/);
      const ref = m ? decodeURIComponent(m[1]) : '';
      const data = verifyByRef[ref];
      if (!data) {
        // Flutterwave returns status:'error' when the tx isn't found.
        return jsonResponse({ status: 'error', message: 'No transaction' });
      }
      return jsonResponse({ status: 'success', data });
    }
    // WhatsApp Cloud API send (notify / alertAdmin) — benign OK.
    if (url.includes('/messages')) {
      return jsonResponse({ messages: [{ id: 'wamid.test' }] });
    }
    return jsonResponse({ status: 'success', data: {} });
  };
}

function baseEnv(orders) {
  return {
    DB: makeD1({ orders }),
    SESSION_KV: makeKV(),
    PHONE_NUMBER_ID: 'PNID',
    WHATSAPP_TOKEN: 'tok',
    // ADMIN_ALERT_PHONE intentionally unset for the happy path.
  };
}

test('confirms a verified-successful, amount-matching pending order', async () => {
  const env = baseEnv([{
    id: 1,
    user_phone: '2348000000010',
    total_price: 6500,
    status: 'pending',
    payment_status: 'pending',
    payment_reference: 'ref-ok',
    paid_at: null,
  }]);

  const restore = installFetch(fetchRouter({
    'ref-ok': { id: 555, status: 'successful', amount: 6500, currency: 'NGN', tx_ref: 'ref-ok' },
  }));

  let summary;
  try {
    summary = await reconcilePendingPayments(env);
  } finally {
    restore();
  }

  assert.equal(summary.scanned, 1);
  assert.equal(summary.confirmed, 1);
  assert.equal(env.DB.orders[0].payment_status, 'paid');
  assert.ok(env.DB.orders[0].paid_at, 'paid_at set');
});

test('amount mismatch -> NOT paid, counted as mismatched, admin alerted', async () => {
  const env = baseEnv([{
    id: 2,
    user_phone: '2348000000011',
    total_price: 6500,
    status: 'pending',
    payment_status: 'pending',
    payment_reference: 'ref-bad-amt',
    paid_at: null,
  }]);
  env.ADMIN_ALERT_PHONE = '2348000000099';

  const restore = installFetch(fetchRouter({
    'ref-bad-amt': { id: 556, status: 'successful', amount: 100, currency: 'NGN', tx_ref: 'ref-bad-amt' },
  }));

  let summary;
  try {
    summary = await reconcilePendingPayments(env);
  } finally {
    restore();
  }

  assert.equal(summary.mismatched, 1);
  assert.equal(summary.confirmed, 0);
  assert.equal(env.DB.orders[0].payment_status, 'pending', 'must NOT mark paid on mismatch');
  // alertAdmin wrote a KV record (best-effort side channel).
  const alertKeys = [...env.SESSION_KV.store.keys()].filter(k => k.startsWith('alert:'));
  assert.ok(alertKeys.length >= 1, 'mismatch should record an alert');
});

test('ages out a long-stale pending order to failed', async () => {
  const env = baseEnv([{
    id: 3,
    user_phone: '2348000000012',
    total_price: 4000,
    status: 'pending',
    payment_status: 'pending',
    payment_reference: 'ref-stale',
    paid_at: null,
    __stale: true, // mock flag: created_at < now-1day (age-out window)
  }]);

  // verify reports still-pending (not successful) at Flutterwave.
  const restore = installFetch(fetchRouter({
    'ref-stale': { id: 557, status: 'pending', amount: 4000, currency: 'NGN', tx_ref: 'ref-stale' },
  }));

  let summary;
  try {
    summary = await reconcilePendingPayments(env);
  } finally {
    restore();
  }

  assert.equal(summary.confirmed, 0);
  assert.equal(summary.aged_out, 1);
  assert.equal(env.DB.orders[0].payment_status, 'failed');
});

test('confirms the verified one AND ages out the stale one in one sweep', async () => {
  const env = baseEnv([
    {
      id: 4, user_phone: 'a', total_price: 6500, status: 'pending',
      payment_status: 'pending', payment_reference: 'ref-good', paid_at: null,
    },
    {
      id: 5, user_phone: 'b', total_price: 4000, status: 'pending',
      payment_status: 'pending', payment_reference: 'ref-old', paid_at: null,
      __stale: true,
    },
  ]);

  const restore = installFetch(fetchRouter({
    'ref-good': { id: 1, status: 'successful', amount: 6500, currency: 'NGN', tx_ref: 'ref-good' },
    'ref-old': { id: 2, status: 'pending', amount: 4000, currency: 'NGN', tx_ref: 'ref-old' },
  }));

  let summary;
  try {
    summary = await reconcilePendingPayments(env);
  } finally {
    restore();
  }

  assert.equal(summary.confirmed, 1);
  assert.equal(summary.aged_out, 1);
  const good = env.DB.orders.find(o => o.id === 4);
  const old = env.DB.orders.find(o => o.id === 5);
  assert.equal(good.payment_status, 'paid');
  assert.equal(old.payment_status, 'failed');
});

test('a verify failure on one order does not abort the sweep (never throws)', async () => {
  const env = baseEnv([
    {
      id: 6, user_phone: 'a', total_price: 6500, status: 'pending',
      payment_status: 'pending', payment_reference: 'ref-throws', paid_at: null,
    },
    {
      id: 7, user_phone: 'b', total_price: 6500, status: 'pending',
      payment_status: 'pending', payment_reference: 'ref-fine', paid_at: null,
    },
  ]);

  // ref-throws returns an error envelope (verify throws); ref-fine succeeds.
  const restore = installFetch((url) => {
    if (url.includes('verify_by_reference')) {
      if (url.includes('ref-throws')) {
        return jsonResponse({ status: 'error', message: 'boom' }, { ok: false, status: 500 });
      }
      return jsonResponse({
        status: 'success',
        data: { id: 9, status: 'successful', amount: 6500, currency: 'NGN', tx_ref: 'ref-fine' },
      });
    }
    return jsonResponse({ messages: [{ id: 'wamid' }] });
  });

  let summary;
  try {
    summary = await reconcilePendingPayments(env);
  } finally {
    restore();
  }

  assert.equal(summary.errors, 1, 'the throwing order is isolated');
  assert.equal(summary.confirmed, 1, 'the healthy order still confirms');
  assert.equal(env.DB.orders.find(o => o.id === 7).payment_status, 'paid');
});

test('currency other than NGN is not confirmed', async () => {
  const env = baseEnv([{
    id: 8, user_phone: 'a', total_price: 6500, status: 'pending',
    payment_status: 'pending', payment_reference: 'ref-usd', paid_at: null,
  }]);

  const restore = installFetch(fetchRouter({
    'ref-usd': { id: 10, status: 'successful', amount: 6500, currency: 'USD', tx_ref: 'ref-usd' },
  }));

  let summary;
  try {
    summary = await reconcilePendingPayments(env);
  } finally {
    restore();
  }

  assert.equal(summary.confirmed, 0);
  assert.equal(env.DB.orders[0].payment_status, 'pending');
});
