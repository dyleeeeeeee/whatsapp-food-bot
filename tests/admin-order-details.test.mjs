/**
 * tests/admin-order-details.test.mjs — admin sees who/what/where before
 * changing an order's status.
 *
 * Regression target: selecting an order (from the Active Orders list or by
 * typing its ID) only showed "Order #N — Current: PENDING" and a status
 * picker. The admin could confirm an order without ever seeing the
 * customer's phone, delivery address, notes, or the items ordered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleAdminMessage, formatOrderDetails, notifyAdminsNewOrder,
} from '../src/handlers/admin.js';
import { handleUserMessage } from '../src/handlers/user.js';
import { makeD1, makeKV, installFetch, jsonResponse } from './helpers.mjs';

const ORDER = {
  id: 7,
  user_phone: '2348012345678',
  total_price: 5500,
  status: 'pending',
  address: '12 Allen Avenue, Ikeja',
  notes: 'Call when at the gate',
  payment_status: 'paid',
  payment_reference: 'ref-7',
  payment_url: null,
  payment_access_code: null,
  paid_at: '2026-09-28 10:01:00',
  created_at: '2026-09-28 10:00:00',
  updated_at: '2026-09-28 10:01:00',
};

const ITEMS = [
  { id: 1, order_id: 7, menu_item_id: 3, name: 'Jollof Rice', quantity: 2, unit_price: 2000, notes: 'extra pepper' },
  { id: 2, order_id: 7, menu_item_id: 9, name: 'Chapman', quantity: 1, unit_price: 1500, notes: '' },
];

// Minimal D1 stub answering exactly the two getOrder() statements.
function makeOrderDB() {
  const stmt = (sql) => ({
    params: [],
    bind(...a) { this.params = a; return this; },
    async first() {
      if (/FROM Orders WHERE id = \?/.test(sql) && this.params[0] === ORDER.id) return { ...ORDER };
      return null;
    },
    async all() {
      if (/FROM OrderItems WHERE order_id = \?/.test(sql)) {
        return { results: ITEMS.filter(i => i.order_id === this.params[0]) };
      }
      throw new Error('unexpected SQL: ' + sql);
    },
  });
  return { prepare: stmt };
}

function setup() {
  const sent = [];
  const restore = installFetch(async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return jsonResponse({ messages: [{ id: 'wamid.x' }] });
  });
  const env = {
    DB: makeOrderDB(),
    SESSION_KV: makeKV(),
    PHONE_NUMBER_ID: '123',
    WHATSAPP_TOKEN: 't',
  };
  return { sent, restore, env };
}

function assertDetailsShown(sent) {
  const texts = sent.filter(m => m.type === 'text').map(m => m.text.body);
  const details = texts.find(t => t.includes('Order #7'));
  assert.ok(details, 'an order-details text message was sent');
  for (const needle of [
    '+2348012345678', '12 Allen Avenue, Ikeja', 'Call when at the gate',
    'Jollof Rice ×2', 'extra pepper', 'Chapman ×1', 'PAID',
  ]) {
    assert.ok(details.includes(needle), `details include "${needle}"`);
  }
  // Details must arrive BEFORE the status picker.
  const detailsIdx = sent.findIndex(m => m.type === 'text' && m.text.body === details);
  const listIdx = sent.findIndex(m => m.type === 'interactive' && m.interactive.type === 'list');
  assert.ok(listIdx > detailsIdx, 'status picker follows the details');
}

test('picking an order from the Active Orders list shows its details', async () => {
  const { sent, restore, env } = setup();
  try {
    const session = { state: 'admin_orders_list', adminCtx: {}, cart: [] };
    await handleAdminMessage('admin1', { type: 'list_reply', id: 'astat_7' }, env, session);
    assertDetailsShown(sent);
    assert.equal(session.state, 'admin_update_status_value');
  } finally {
    restore();
  }
});

test('typing an order ID shows its details', async () => {
  const { sent, restore, env } = setup();
  try {
    const session = { state: 'admin_update_status_id', adminCtx: {}, cart: [] };
    await handleAdminMessage('admin1', { type: 'text', text: '7' }, env, session);
    assertDetailsShown(sent);
  } finally {
    restore();
  }
});

test('formatOrderDetails tolerates missing address, notes and items', () => {
  const out = formatOrderDetails({ ...ORDER, address: '', notes: '', items: [] });
  assert.ok(out.includes('(none given)'));
  assert.ok(out.includes('(no items recorded)'));
  assert.ok(!out.includes('Notes:'), 'empty notes line is omitted');
});

test('the customer\'s saved WhatsApp name is shown with their number', async () => {
  const { sent, restore, env } = setup();
  try {
    await env.SESSION_KV.put('name:' + ORDER.user_phone, 'Ada Obi');
    const session = { state: 'admin_orders_list', adminCtx: {}, cart: [] };
    await handleAdminMessage('admin1', { type: 'list_reply', id: 'astat_7' }, env, session);
    const details = sent.find(m => m.type === 'text').text.body;
    assert.ok(details.includes('Ada Obi (+2348012345678)'), details);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────
// New paid order -> every admin is pinged with details + a shortcut.
// ─────────────────────────────────────────────────────────────

function paidOrderEnv(admins) {
  return {
    DB: makeD1({ orders: [{ ...ORDER }], orderItems: ITEMS, admins }),
    SESSION_KV: makeKV({ ['name:' + ORDER.user_phone]: 'Ada Obi' }),
    PHONE_NUMBER_ID: '123',
    WHATSAPP_TOKEN: 't',
  };
}

test('notifyAdminsNewOrder sends each admin the details and an Update Status button', async () => {
  const sent = [];
  const restore = installFetch(async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return jsonResponse({ messages: [{ id: 'wamid.x' }] });
  });
  try {
    await notifyAdminsNewOrder(7, paidOrderEnv(['2340000000001', '2340000000002']));
  } finally {
    restore();
  }
  for (const admin of ['2340000000001', '2340000000002']) {
    const mine = sent.filter(m => m.to === admin);
    assert.equal(mine.length, 2, `two messages to ${admin}`);
    const body = mine[0].text.body;
    assert.ok(body.startsWith('🔔 *New paid order!*'));
    for (const needle of ['Ada Obi', '12 Allen Avenue, Ikeja', 'Jollof Rice ×2', 'Chapman ×1']) {
      assert.ok(body.includes(needle), `ping includes "${needle}"`);
    }
    const btn = mine[1].interactive.action.buttons[0].reply;
    assert.deepEqual(mine[1].interactive.action.buttons.map(b => b.reply.id), ['nstat_7_confirmed', 'astat_7'], 'Confirm first, then open the order');
  }
  assert.equal(sent.filter(m => m.to === ORDER.user_phone).length, 0, 'customer not messaged');
});

test('notifyAdminsNewOrder never throws, even when the DB fails', async () => {
  const env = {
    DB: { prepare() { throw new Error('D1 down'); } },
    SESSION_KV: makeKV(),
  };
  await notifyAdminsNewOrder(7, env); // resolves
});

test('the Update Status button in the ping opens the Active Orders list', async () => {
  const { sent, restore, env } = setup();
  env.DB = paidOrderEnv([]).DB;
  try {
    const session = { state: 'admin_idle', adminCtx: {}, cart: [] };
    await handleAdminMessage('admin1', { type: 'button_reply', id: 'admin_update_status' }, env, session);
    const list = sent.find(m => m.type === 'interactive' && m.interactive.type === 'list');
    assert.ok(list, 'orders list sent');
    const rows = list.interactive.action.sections[0].rows;
    assert.ok(rows.some(r => r.id === 'astat_7'), 'order #7 is tappable');
    assert.ok(rows.find(r => r.id === 'astat_7').description.includes('12 Allen Avenue'),
      'list row now shows the address');
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────
// Placing an order records the customer's WhatsApp profile name.
// ─────────────────────────────────────────────────────────────

test('placing an order saves the customer\'s WhatsApp name', async () => {
  const PHONE = '2348099999999';
  const db = makeD1();
  const basePrepare = db.prepare;
  db.prepare = (sql) => {
    if (/FROM MenuItems WHERE id = \?/.test(sql)) {
      return { bind() { return this; },
        async first() { return { id: 3, name: 'Jollof Rice', price: 2000, is_available: 1 }; } };
    }
    if (/^\s*UPDATE Orders SET (payment_url|payment_access_code)/.test(sql)) {
      return { bind() { return this; }, async run() { return { meta: { changes: 1 } }; } };
    }
    return basePrepare(sql);
  };
  const env = {
    DB: db,
    SESSION_KV: makeKV(),
    PHONE_NUMBER_ID: '123',
    WHATSAPP_TOKEN: 't',
    FLUTTERWAVE_SECRET_KEY: 'sk',
  };
  const restore = installFetch(async (url) => {
    if (url.includes('flutterwave.com/v3/payments')) {
      return jsonResponse({ status: 'success', data: { link: 'https://pay.example/x', id: 99 } });
    }
    return jsonResponse({ messages: [{ id: 'wamid.x' }] });
  });
  try {
    const session = {
      state: 'checkout_confirm',
      cart: [{ itemId: 3, name: 'Jollof Rice', qty: 2, unitPrice: 2000 }],
      tempAddress: '12 Allen Avenue, Ikeja',
      tempOrderNotes: '',
      checkoutId: 'test-checkout',
      profileName: 'Ada Obi',
    };
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'btn_place_order' }, env, session);
  } finally {
    restore();
  }
  assert.equal(db.orders.length, 1, 'order was created');
  assert.equal(await env.SESSION_KV.get('name:' + PHONE), 'Ada Obi');
});

test('the webhook keeps the sender\'s WhatsApp profile name on their session', async () => {
  const { handleWebhookPost } = await import('../src/webhook.js');
  const env = { DB: makeD1(), SESSION_KV: makeKV(), PHONE_NUMBER_ID: '1', WHATSAPP_TOKEN: 't' };
  const restore = installFetch(async () => jsonResponse({ messages: [{ id: 'x' }] }));
  try {
    await handleWebhookPost({ entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '2348011111111', profile: { name: 'Ada Obi' } }],
      messages: [{ from: '2348011111111', id: 'wamid.1', type: 'text', text: { body: 'CART' } }],
    } }] }] }, env);
  } finally {
    restore();
  }
  const session = JSON.parse(await env.SESSION_KV.get('session:2348011111111'));
  assert.equal(session.profileName, 'Ada Obi');
});
