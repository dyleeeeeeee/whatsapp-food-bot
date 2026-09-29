/**
 * tests/admin-flows.test.mjs — admin UI/product behaviour, driven through the
 * real handleAdminMessage with a small in-memory D1 + KV and a fetch stub
 * that records every WhatsApp message the bot sends.
 *
 * Covers: menu fits WhatsApp's 10-row cap, the orders list shows paid orders
 * only, the status picker offers only valid next steps, unpaid orders can't
 * be cooked, one-tap next-step buttons, the service-fee line, name search in
 * the item pickers, bulk Clear, and View Categories showing every item.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleAdminMessage, formatOrderDetails } from '../src/handlers/admin.js';
import { makeKV, installFetch, jsonResponse } from './helpers.mjs';

const ADMIN = '2340000000001';

// ─────────────────────────────────────────────────────────────
// In-memory D1: answers the statements the admin flows under test issue.
// ─────────────────────────────────────────────────────────────
function makeDB(seed) {
  const db = {
    orders:     seed.orders || [],
    orderItems: seed.orderItems || [],
    items:      seed.items || [],
    categories: seed.categories || [],
  };
  const active = o => ['pending', 'confirmed', 'preparing', 'ready'].includes(o.status);
  const match = (i, q) => !q || i.name.toLowerCase().includes(q.toLowerCase());

  function run(sql, p) {
    sql = sql.replace(/\s+/g, ' ').trim();

    if (/FROM Orders WHERE id = \?/.test(sql)) return { first: db.orders.find(o => o.id === p[0]) || null };
    if (/FROM OrderItems WHERE order_id = \?/.test(sql)) return { all: db.orderItems.filter(i => i.order_id === p[0]) };
    if (/^UPDATE Orders SET status = \?/.test(sql)) {
      db.orders.find(o => o.id === p[1]).status = p[0];
      return { changes: 1 };
    }
    if (/FROM Orders WHERE status IN/.test(sql)) {
      let rows = db.orders.filter(active);
      if (/payment_status = 'paid'/.test(sql)) rows = rows.filter(o => o.payment_status === 'paid');
      if (/payment_status != 'paid'/.test(sql)) rows = rows.filter(o => o.payment_status !== 'paid');
      if (/COUNT\(\*\)/.test(sql)) return { first: { total: rows.length } };
      return { all: rows.slice(p[1], p[1] + p[0]) };
    }

    if (/FROM MenuCategories ORDER BY/.test(sql)) return { all: db.categories };
    if (/SELECT id, name FROM MenuCategories WHERE id = \?/.test(sql)) {
      return { first: db.categories.find(c => c.id === p[0]) || null };
    }
    if (/FROM MenuItems WHERE id = \?/.test(sql)) return { first: db.items.find(i => i.id === p[0]) || null };
    if (/FROM MenuItems ORDER BY name$/.test(sql)) return { all: [...db.items].sort((a, b) => a.name.localeCompare(b.name)) };
    if (/FROM MenuItems/.test(sql) && /(LIMIT|COUNT)/.test(sql)) {
      const q = /instr/.test(sql) ? p[0] : '';
      const rows = db.items.filter(i => match(i, q)).sort((a, b) => a.name.localeCompare(b.name));
      if (/COUNT\(\*\)/.test(sql)) return { first: { total: rows.length } };
      const [limit, offset] = q ? p.slice(1) : p;
      return { all: rows.slice(offset, offset + limit) };
    }
    if (/^UPDATE MenuItems SET is_available = \? WHERE id = \?/.test(sql)) {
      db.items.find(i => i.id === p[1]).is_available = p[0];
      return { changes: 1 };
    }
    throw new Error('admin-flows mock D1: unhandled SQL: ' + sql);
  }

  db.prepare = (sql) => ({
    params: [],
    bind(...a) { this.params = a; return this; },
    async first(col) {
      const r = run(sql, this.params).first ?? null;
      return col && r ? r[col] : r;
    },
    async all() { return { results: run(sql, this.params).all || [] }; },
    async run() { return { meta: { changes: run(sql, this.params).changes || 0 } }; },
  });
  return db;
}

function paidOrder(over = {}) {
  return {
    id: 23, user_phone: '2348030000000', total_price: 2000, status: 'pending',
    address: 'Room 1', notes: '', payment_status: 'paid', payment_reference: 'r23',
    payment_access_code: 'tx23', created_at: '2026-09-28 14:55:08', ...over,
  };
}

// Run fn with the WhatsApp API stubbed; returns every message sent.
async function capture(fn) {
  const sent = [];
  const restore = installFetch(async (url, opts) => {
    if (opts?.body) sent.push(JSON.parse(opts.body));
    return jsonResponse({ messages: [{ id: 'wamid.x' }] });
  });
  try { await fn(); } finally { restore(); }
  return sent;
}

function envWith(seed) {
  return { DB: makeDB(seed), SESSION_KV: makeKV(), PHONE_NUMBER_ID: '1', WHATSAPP_TOKEN: 't' };
}

const listOf = sent => sent.filter(m => m.interactive?.type === 'list').at(-1);
const rowsOf = msg => msg.interactive.action.sections.flatMap(s => s.rows);
const buttonsOf = msg => msg.interactive.action.buttons.map(b => b.reply);
const textOf = m => m.text?.body ?? m.interactive?.body?.text ?? '';

// ─────────────────────────────────────────────────────────────
// Admin menu
// ─────────────────────────────────────────────────────────────

test('admin menu fits the 10-row limit, so User Mode is visible', async () => {
  const env = envWith({});
  const sent = await capture(() =>
    handleAdminMessage(ADMIN, { type: 'text', text: 'ADMIN' }, env, { state: 'admin_idle', adminCtx: {} }));
  const rows = rowsOf(listOf(sent));
  assert.ok(rows.length <= 10, `menu has ${rows.length} rows`);
  assert.ok(rows.some(r => r.id === 'admin_user_mode'), 'User Mode row present');
  assert.equal(rows[0].id, 'admin_update_status', 'Orders is the first row');
});

// ─────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────

test('orders list shows paid orders only and says how many unpaid are hidden', async () => {
  const env = envWith({ orders: [
    paidOrder({ id: 1 }),
    paidOrder({ id: 2, payment_status: 'failed' }),
    paidOrder({ id: 3, payment_status: 'pending' }),
  ] });
  const sent = await capture(() =>
    handleAdminMessage(ADMIN, { type: 'button_reply', id: 'admin_update_status' }, env, { state: 'admin_idle', adminCtx: {} }));
  const list = listOf(sent);
  const orderRows = rowsOf(list).filter(r => r.id.startsWith('astat_'));
  assert.deepEqual(orderRows.map(r => r.id), ['astat_1']);
  assert.equal(orderRows[0].title, '#1 · ₦2,000');
  assert.ok(orderRows[0].description.includes('Room 1'));
  assert.ok(textOf(list).includes('2 unpaid orders not shown'));
});

test('status picker offers only the valid next statuses', async () => {
  const env = envWith({ orders: [paidOrder({ status: 'confirmed' })] });
  const sent = await capture(() =>
    handleAdminMessage(ADMIN, { type: 'list_reply', id: 'astat_23' }, env, { state: 'admin_orders_list', adminCtx: {} }));
  const ids = rowsOf(listOf(sent)).map(r => r.id);
  assert.deepEqual(ids, ['status_preparing', 'status_ready', 'status_delivered', 'status_cancelled']);
});

test('an unpaid order can only be cancelled, and Confirm is refused', async () => {
  const env = envWith({ orders: [paidOrder({ payment_status: 'failed' })] });
  const session = { state: 'admin_orders_list', adminCtx: {} };
  let sent = await capture(() =>
    handleAdminMessage(ADMIN, { type: 'list_reply', id: 'astat_23' }, env, session));
  assert.deepEqual(rowsOf(listOf(sent)).map(r => r.id), ['status_cancelled']);

  sent = await capture(() =>
    handleAdminMessage(ADMIN, { type: 'button_reply', id: 'nstat_23_confirmed' }, env, { state: 'admin_idle', adminCtx: {} }));
  assert.ok(textOf(sent.at(-1)).includes("isn't paid"), textOf(sent.at(-1)));
  assert.equal(env.DB.orders[0].status, 'pending', 'order untouched');
});

test('one-tap Confirm updates the order and offers the next step', async () => {
  const env = envWith({ orders: [paidOrder()] });
  const sent = await capture(() =>
    handleAdminMessage(ADMIN, { type: 'button_reply', id: 'nstat_23_confirmed' }, env, { state: 'admin_idle', adminCtx: {} }));
  assert.equal(env.DB.orders[0].status, 'confirmed');
  const customerMsg = sent.find(m => m.to === '2348030000000');
  assert.ok(customerMsg, 'customer notified');
  const reply = sent.filter(m => m.to === ADMIN).at(-1);
  assert.equal(buttonsOf(reply)[0].id, 'nstat_23_preparing', 'next step is Preparing');
});

test('a stale Confirm tap on an already-confirmed order changes nothing', async () => {
  const env = envWith({ orders: [paidOrder({ status: 'confirmed' })] });
  const sent = await capture(() =>
    handleAdminMessage(ADMIN, { type: 'button_reply', id: 'nstat_23_confirmed' }, env, { state: 'admin_idle', adminCtx: {} }));
  assert.ok(textOf(sent.at(-1)).includes('already *CONFIRMED*'));
  assert.equal(sent.filter(m => m.to === '2348030000000').length, 0, 'customer not re-notified');
});

test('order details show the service fee so the numbers add up', () => {
  const out = formatOrderDetails({
    ...paidOrder(),
    items: [
      { name: 'Food Pack', quantity: 1, unit_price: 200, notes: '' },
      { name: 'Fried Rice', quantity: 2, unit_price: 600, notes: '' },
    ],
  });
  assert.ok(out.includes('Service fee:* ₦600'), out);
  assert.ok(out.includes('Total:* ₦2,000'));
});

// ─────────────────────────────────────────────────────────────
// Menu item pickers
// ─────────────────────────────────────────────────────────────

const MENU = {
  categories: [{ id: 1, name: 'Mains', sort_order: 0 }, { id: 2, name: 'Drinks', sort_order: 1 }],
  items: [
    { id: 1, category_id: 1, name: 'Jollof Rice', price: 1500, is_available: 1, description: '', image_url: '' },
    { id: 2, category_id: 1, name: 'Fried Rice',  price: 1500, is_available: 1, description: '', image_url: '' },
    { id: 3, category_id: 1, name: 'Chicken',     price: 2000, is_available: 0, description: '', image_url: '' },
    { id: 4, category_id: 2, name: 'Chapman',     price: 800,  is_available: 1, description: '', image_url: '' },
  ],
};

test('typing a name in In/Out of Stock filters the items; ALL clears it', async () => {
  const env = envWith(structuredClone(MENU));
  const session = { state: 'admin_idle', adminCtx: {} };
  await capture(() => handleAdminMessage(ADMIN, { type: 'list_reply', id: 'admin_toggle_item' }, env, session));

  let sent = await capture(() => handleAdminMessage(ADMIN, { type: 'text', text: 'rice' }, env, session));
  assert.deepEqual(rowsOf(listOf(sent)).map(r => r.title), ['Fried Rice', 'Jollof Rice']);

  sent = await capture(() => handleAdminMessage(ADMIN, { type: 'list_reply', id: 'tog_1' }, env, session));
  assert.equal(env.DB.items[0].is_available, 0, 'Jollof Rice toggled off');

  sent = await capture(() => handleAdminMessage(ADMIN, { type: 'text', text: 'zzz' }, env, session));
  assert.ok(textOf(sent[0]).includes('No items match "zzz"'));

  sent = await capture(() => handleAdminMessage(ADMIN, { type: 'text', text: 'ALL' }, env, session));
  assert.equal(rowsOf(listOf(sent)).length, 4, 'all items back');
});

test('bulk Remove Items: typed search filters, and Clear really clears', async () => {
  const env = envWith(structuredClone(MENU));
  const session = { state: 'admin_bulk_menu', adminCtx: {} };
  await capture(() => handleAdminMessage(ADMIN, { type: 'list_reply', id: 'bulk_items_remove' }, env, session));

  let sent = await capture(() => handleAdminMessage(ADMIN, { type: 'text', text: 'chap' }, env, session));
  const itemRows = rowsOf(listOf(sent)).filter(r => r.id.startsWith('bsr_'));
  assert.deepEqual(itemRows.map(r => r.id), ['bsr_4']);

  await capture(() => handleAdminMessage(ADMIN, { type: 'list_reply', id: 'bsr_4' }, env, session));
  assert.equal(await env.SESSION_KV.get('bulksel:' + ADMIN), '[4]');

});

test('bulk Orders: Clear wipes the stored selection so Review starts empty', async () => {
  const env = envWith({ orders: [paidOrder({ id: 1 }), paidOrder({ id: 2 })] });
  const session = { state: 'admin_bulk_menu', adminCtx: {} };
  await capture(() => handleAdminMessage(ADMIN, { type: 'list_reply', id: 'bulk_orders' }, env, session));
  await capture(() => handleAdminMessage(ADMIN, { type: 'list_reply', id: 'ba_os_cancelled' }, env, session));
  await capture(() => handleAdminMessage(ADMIN, { type: 'list_reply', id: 'bs_o_1' }, env, session));
  assert.equal(await env.SESSION_KV.get('bulksel:' + ADMIN), '[1]');

  await capture(() => handleAdminMessage(ADMIN, { type: 'button_reply', id: 'bulk_clear' }, env, session));
  const sent = await capture(() => handleAdminMessage(ADMIN, { type: 'list_reply', id: 'bulk_review' }, env, session));
  assert.ok(textOf(sent.at(-1)).includes('select at least one order'), textOf(sent.at(-1)));
});

test('View Categories counts and lists unavailable items too', async () => {
  const env = envWith(structuredClone(MENU));
  const session = { state: 'admin_idle', adminCtx: {} };
  let sent = await capture(() => handleAdminMessage(ADMIN, { type: 'list_reply', id: 'admin_view_cats' }, env, session));
  const mains = rowsOf(listOf(sent)).find(r => r.id === 'cat_1');
  assert.equal(mains.description, '3 items · 1 unavailable');

  sent = await capture(() => handleAdminMessage(ADMIN, { type: 'list_reply', id: 'cat_1' }, env, session));
  const listing = textOf(sent[0]);
  assert.ok(listing.includes('Chicken — ₦2,000 ❌ _unavailable_'), listing);
  assert.ok(listing.includes('Jollof Rice — ₦1,500'));
});

test('Add Item category step offers a New Category row', async () => {
  const env = envWith(structuredClone(MENU));
  const session = { state: 'admin_add_item_name', adminCtx: {} };
  env.DB.prepare = ((base) => (sql) => /LOWER\(name\) = LOWER\(\?\)/.test(sql)
    ? { bind() { return this; }, async first() { return null; } }
    : base(sql))(env.DB.prepare);
  const sent = await capture(() => handleAdminMessage(ADMIN, { type: 'text', text: 'Suya' }, env, session));
  const ids = rowsOf(listOf(sent)).map(r => r.id);
  assert.deepEqual(ids, ['acat_1', 'acat_2', 'admin_add_cat']);
});
