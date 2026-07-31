/**
 * tests/flow-caps.test.mjs — three more user-flow defects found while auditing.
 *
 * 1. LIST CAPS. WhatsApp caps a list at 10 TOTAL rows and silently drops the
 *    overflow. The item list was paginated; the CATEGORY list and the MANAGE
 *    CART list were not. So an 11th category was unreachable, and a 10-line
 *    cart lost its "Clear Cart" row (11+ lines lost the trailing items too —
 *    they could not be edited or removed at all).
 *
 * 2. ADDRESS HIJACK. Free text was inferred as a delivery address whenever the
 *    cart was non-empty, so a question typed while browsing ("do you have
 *    coke") became the delivery address and pushed the user into checkout.
 *
 * 3. REORDER WIPE. Reorder assigned session.cart outright, discarding whatever
 *    was already in the cart, while telling the user the items were "added".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleUserMessage,
  buildCategoryListRows,
  buildCartManageRows,
} from '../src/handlers/user.js';
import { makeKV, installFetch, jsonResponse } from './helpers.mjs';

const PHONE = '2348000000011';
const LIST_MAX_ROWS = 10;

// ─────────────────────────────────────────────────────────────
// 1a. Category list — pure row budget
// ─────────────────────────────────────────────────────────────

const mkCats = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Category ${i + 1}` }));

test('every category page stays within the 10-row cap', () => {
  for (const count of [1, 8, 9, 11, 25, 40]) {
    const cats = mkCats(count);
    const totalPages = Math.max(1, Math.ceil(count / 8));
    for (let p = 0; p < totalPages; p++) {
      const { rows } = buildCategoryListRows(cats, {}, p);
      assert.ok(rows.length <= LIST_MAX_ROWS,
        `${count} categories, page ${p}: ${rows.length} rows exceeds the cap`);
    }
  }
});

test('every category is reachable by walking Next', () => {
  const cats = mkCats(25);
  const seen = new Set();
  let page = 0;

  for (let guard = 0; guard < 20; guard++) {
    const { rows } = buildCategoryListRows(cats, {}, page);
    rows.filter(r => r.id.startsWith('cat_')).forEach(r => seen.add(r.id));
    const next = rows.find(r => r.id.startsWith('catpage_next_'));
    if (!next) break;
    page = parseInt(next.id.split('_')[2], 10);
  }

  assert.equal(seen.size, 25, 'a category the user can never reach is a lost sale');
});

test('an out-of-range category page clamps instead of rendering empty', () => {
  const { rows, page } = buildCategoryListRows(mkCats(9), {}, 99);
  assert.equal(page, 1);
  assert.ok(rows.some(r => r.id.startsWith('cat_')));
});

// ─────────────────────────────────────────────────────────────
// 1b. Manage Cart — pure row budget
// ─────────────────────────────────────────────────────────────

const mkCart = (n) => Array.from({ length: n }, (_, i) => ({
  itemId: i + 1, name: `Line ${i + 1}`, qty: 1, unitPrice: 500, notes: '',
}));

test('Clear Cart survives on every Manage Cart page', () => {
  for (const count of [1, 7, 10, 11, 23]) {
    const cart = mkCart(count);
    const totalPages = Math.max(1, Math.ceil(count / 7));
    for (let p = 0; p < totalPages; p++) {
      const { rows } = buildCartManageRows(cart, p);
      assert.ok(rows.length <= LIST_MAX_ROWS,
        `${count} lines, page ${p}: ${rows.length} rows exceeds the cap`);
      assert.ok(rows.some(r => r.id === 'cart_clear_all'),
        `${count} lines, page ${p}: Clear Cart was dropped`);
    }
  }
});

test('cart rows keep their ABSOLUTE index on later pages', () => {
  const { rows } = buildCartManageRows(mkCart(12), 1);
  const lines = rows.filter(r => r.id.startsWith('cart_idx_'));
  assert.deepEqual(
    lines.map(r => r.id),
    ['cart_idx_7_8', 'cart_idx_8_9', 'cart_idx_9_10', 'cart_idx_10_11', 'cart_idx_11_12'],
    'a page-relative index would edit the wrong line'
  );
});

test('every cart line is reachable by walking Next', () => {
  const cart = mkCart(23);
  const seen = new Set();
  let page = 0;

  for (let guard = 0; guard < 20; guard++) {
    const { rows } = buildCartManageRows(cart, page);
    rows.filter(r => r.id.startsWith('cart_idx_')).forEach(r => seen.add(r.id));
    const next = rows.find(r => r.id.startsWith('cartpage_next_'));
    if (!next) break;
    page = parseInt(next.id.split('_')[2], 10);
  }

  assert.equal(seen.size, 23, 'an unreachable cart line cannot be edited or removed');
});

// ─────────────────────────────────────────────────────────────
// End-to-end harness for the wired-up flows
// ─────────────────────────────────────────────────────────────

const ITEMS = [
  { id: 1, category_id: 1, name: 'Fried Rice', description: 'Party jollof',
    price: 3500, image_url: null, is_available: 1 },
  { id: 9, category_id: 2, name: 'Bottled Water', description: 'Chilled 75cl',
    price: 500, image_url: null, is_available: 1 },
];

// Menu + order reads for the flows under test.
function makeDB({ categories = mkCats(3), order = null } = {}) {
  return {
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      return {
        params: [],
        bind(...args) { this.params = args; return this; },
        async all() {
          if (/FROM MenuCategories/i.test(s)) return { results: categories, meta: {} };
          if (/FROM MenuItems/i.test(s)) return { results: ITEMS, meta: {} };
          if (/FROM OrderItems/i.test(s)) return { results: order ? order.items : [], meta: {} };
          throw new Error(`mock DB: unhandled SQL: ${s}`);
        },
        async first() {
          if (/FROM MenuItems WHERE id = \? AND is_available = 1/i.test(s)) {
            return ITEMS.find(i => i.id === this.params[0] && i.is_available) || null;
          }
          if (/FROM MenuItems WHERE id = \?/i.test(s)) {
            return ITEMS.find(i => i.id === this.params[0]) || null;
          }
          if (/FROM Orders WHERE id = \?/i.test(s)) {
            return order && order.id === this.params[0] ? order : null;
          }
          throw new Error(`mock DB: unhandled SQL: ${s}`);
        },
      };
    },
  };
}

function makeEnv({ session, cart, categories, order }) {
  const kv = makeKV({
    [`session:${PHONE}`]: JSON.stringify(session),
    [`cart:${PHONE}`]: JSON.stringify(cart || []),
  });
  const sent = [];
  const restore = installFetch(async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return jsonResponse({ messages: [{ id: 'wamid.test' }] });
  });
  return {
    env: { SESSION_KV: kv, DB: makeDB({ categories, order }), PHONE_NUMBER_ID: '123', WHATSAPP_TOKEN: 't' },
    kv, sent, restore,
  };
}

const lastSent = (sent) => sent[sent.length - 1];
const bodyOf = (m) => m?.interactive?.body?.text || m?.text?.body || '';
const rowsOf = (m) => (m?.interactive?.action?.sections || []).flatMap(s => s.rows || []);
const readCart = async (kv) => JSON.parse(await kv.get(`cart:${PHONE}`));

function tapRow(msg, title) {
  const row = rowsOf(msg).find(r => r.title === title);
  assert.ok(row, `expected a row titled "${title}"`);
  return { type: 'list_reply', id: row.id, title: row.title };
}

// ─────────────────────────────────────────────────────────────
// 1c. The pagination is actually wired to the handlers
// ─────────────────────────────────────────────────────────────

test('tapping Next on the category list advances the page', async () => {
  const { env, sent, restore } = makeEnv({
    session: { state: 'idle', adminCtx: {} },
    categories: mkCats(14),
  });

  try {
    await handleUserMessage(PHONE, { type: 'text', text: 'MENU' }, env);
    const first = rowsOf(lastSent(sent)).filter(r => r.id.startsWith('cat_')).length;
    assert.equal(first, 8);

    await handleUserMessage(PHONE, tapRow(lastSent(sent), '➡️ Next'), env);
    const second = rowsOf(lastSent(sent)).filter(r => r.id.startsWith('cat_'));
    assert.equal(second.length, 6, 'page 2 must carry the remaining categories');
    assert.match(bodyOf(lastSent(sent)), /Page 2\/2/);
  } finally {
    restore();
  }
});

test('a cart line on Manage Cart page 2 opens the line the user tapped', async () => {
  const cart = mkCart(12);
  const { env, sent, restore } = makeEnv({
    session: { state: 'cart_review', adminCtx: {} },
    cart,
  });

  try {
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'btn_manage_cart', title: 'Manage' }, env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), '➡️ Next'), env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), 'Line 9 (x1)'), env);

    assert.match(bodyOf(lastSent(sent)), /Managing: Line 9/);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 2. Free text must not be swallowed as a delivery address
// ─────────────────────────────────────────────────────────────

test('a question typed while browsing is NOT taken as a delivery address', async () => {
  const { env, kv, sent, restore } = makeEnv({
    // Items in the cart, but checkout was never started (no checkoutId).
    session: { state: 'browsing_menu', adminCtx: {} },
    cart: [{ itemId: 1, name: 'Fried Rice', qty: 1, unitPrice: 3500, notes: '' }],
  });

  try {
    await handleUserMessage(PHONE, { type: 'text', text: 'do you have coke' }, env);

    const bodies = sent.map(bodyOf).join('\n');
    assert.doesNotMatch(bodies, /delivery instructions/i,
      'the user was silently pushed into checkout');
    const saved = JSON.parse(await kv.get(`session:${PHONE}`));
    assert.equal(saved.tempAddress, undefined,
      'a browsing question must never become the delivery address');
  } finally {
    restore();
  }
});

test('typed address after tapping Checkout is still recovered', async () => {
  const { env, kv, sent, restore } = makeEnv({
    // checkoutId present = the user really did start checkout; state lagged.
    session: { state: 'cart_review', adminCtx: {}, checkoutId: 'abc-123' },
    cart: [{ itemId: 1, name: 'Fried Rice', qty: 1, unitPrice: 3500, notes: '' }],
  });

  try {
    await handleUserMessage(PHONE, { type: 'text', text: '12 Allen Avenue, Ikeja' }, env);

    assert.match(bodyOf(lastSent(sent)), /delivery instructions/i);
    const saved = JSON.parse(await kv.get(`session:${PHONE}`));
    assert.equal(saved.tempAddress, '12 Allen Avenue, Ikeja');
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 3. Reorder must add to the cart, not replace it
// ─────────────────────────────────────────────────────────────

test('reorder merges into the existing cart instead of wiping it', async () => {
  const order = {
    id: 77, user_phone: PHONE, total_price: 4000, status: 'delivered',
    address: '12 Allen Ave', notes: '', payment_status: 'paid',
    payment_reference: 'FCHOW-x', payment_url: null, payment_access_code: null,
    paid_at: '2026-06-01', created_at: '2026-06-01', updated_at: '2026-06-01',
    items: [
      { id: 1, order_id: 77, menu_item_id: 9, name: 'Bottled Water',
        quantity: 2, unit_price: 500, notes: '' },
    ],
  };

  const { env, kv, restore } = makeEnv({
    session: { state: 'order_tracking', adminCtx: {} },
    cart: [{ itemId: 1, name: 'Fried Rice', qty: 1, unitPrice: 3500, notes: '' }],
    order,
  });

  try {
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'reorder_77', title: 'Reorder' }, env);

    assert.deepEqual(
      (await readCart(kv)).map(l => [l.name, l.qty]),
      [['Fried Rice', 1], ['Bottled Water', 2]],
      'items already in the cart must survive a reorder'
    );
  } finally {
    restore();
  }
});
