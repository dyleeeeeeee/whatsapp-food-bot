/**
 * tests/wrong-item.test.mjs — the tapped item must be the item that acts.
 *
 * Field report: "I tapped Bottled Water and it added Fried Rice to my cart."
 *
 * Two independent causes, both the same class of defect — the handler trusted
 * SCRATCH SESSION STATE over the ground truth carried in the tap's id:
 *
 *   1. A "Change Qty" started from Manage Cart set session.cartQtyEdit, and
 *      nothing cleared it when the user walked away (MENU / browse / open a
 *      different item). The next quantity pick — for a completely different
 *      menu item — was still routed to updateCartQty and mutated the OLD cart
 *      line. The item the user tapped never entered the cart.
 *   2. handleItemDetail only adopted the item id embedded in the button
 *      (qty_1_{itemId}) when session.tempItemId was empty, so a stale KV read
 *      (Workers KV is eventually consistent) silently added the previously
 *      viewed item instead.
 *
 * These tests drive the real handler end-to-end and tap the rows the bot
 * actually rendered, so they stay honest if the row-id scheme changes again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleUserMessage } from '../src/handlers/user.js';
import { makeKV, installFetch, jsonResponse } from './helpers.mjs';

const PHONE = '2348000000009';

const CATEGORIES = [
  { id: 1, name: 'Rice', sort_order: 1 },
  { id: 2, name: 'Drinks', sort_order: 2 },
];

const ITEMS = [
  { id: 1, category_id: 1, name: 'Fried Rice', description: 'Party jollof',
    price: 3500, image_url: null, is_available: 1 },
  { id: 9, category_id: 2, name: 'Bottled Water', description: 'Chilled 75cl',
    price: 500, image_url: null, is_available: 1 },
];

// Minimal D1 stand-in covering only the menu reads these flows perform.
function makeMenuDB() {
  return {
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      return {
        params: [],
        bind(...args) { this.params = args; return this; },
        async all() {
          if (/FROM MenuCategories/i.test(s)) return { results: CATEGORIES, meta: {} };
          if (/FROM MenuItems/i.test(s)) {
            return { results: ITEMS.filter(i => i.is_available), meta: {} };
          }
          throw new Error(`mock DB: unhandled SQL: ${s}`);
        },
        async first() {
          if (/FROM MenuItems WHERE id = \? AND is_available = 1/i.test(s)) {
            return ITEMS.find(i => i.id === this.params[0] && i.is_available) || null;
          }
          if (/FROM MenuItems WHERE id = \?/i.test(s)) {
            return ITEMS.find(i => i.id === this.params[0]) || null;
          }
          throw new Error(`mock DB: unhandled SQL: ${s}`);
        },
      };
    },
  };
}

// Build an env plus a capture of everything the bot sent.
function makeEnv({ session, cart }) {
  const kv = makeKV({
    [`session:${PHONE}`]: JSON.stringify(session),
    [`cart:${PHONE}`]: JSON.stringify(cart || []),
  });
  const sent = [];
  const restore = installFetch(async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return jsonResponse({ messages: [{ id: 'wamid.test' }] });
  });
  const env = {
    SESSION_KV: kv,
    DB: makeMenuDB(),
    PHONE_NUMBER_ID: '123',
    WHATSAPP_TOKEN: 'test-token',
  };
  return { env, kv, sent, restore };
}

const lastSent = (sent) => sent[sent.length - 1];

function rowsOf(msg) {
  const sections = msg?.interactive?.action?.sections || [];
  return sections.flatMap(s => s.rows || []);
}

// Tap the list row the user would tap — by its visible title.
function tapRow(msg, title) {
  const row = rowsOf(msg).find(r => r.title === title);
  assert.ok(row, `expected a list row titled "${title}" in ${JSON.stringify(rowsOf(msg))}`);
  return { type: 'list_reply', id: row.id, title: row.title };
}

const readCart = async (kv) => JSON.parse(await kv.get(`cart:${PHONE}`));
const bodyOf = (msg) => msg?.interactive?.body?.text || msg?.text?.body || '';

// ─────────────────────────────────────────────────────────────
// Cause 1 — an abandoned cart "Change Qty" hijacks the next item
// ─────────────────────────────────────────────────────────────

// The exact reported journey: start a qty edit on Fried Rice, walk away,
// browse to Bottled Water, choose a quantity. Bottled Water must be added.
test('abandoned cart qty-edit does not hijack a new item pick', async () => {
  const { env, kv, sent, restore } = makeEnv({
    session: { state: 'cart_review', adminCtx: {} },
    cart: [{ itemId: 1, name: 'Fried Rice', qty: 1, unitPrice: 3500, notes: '' }],
  });

  try {
    // Manage Cart → tap the Fried Rice line → Change Qty
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'btn_manage_cart', title: 'Manage' }, env);
    const cartLine = tapRow(lastSent(sent), 'Fried Rice (x1)');
    await handleUserMessage(PHONE, cartLine, env);
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'cart_item_qty', title: 'Change Qty' }, env);

    // …then walk away without picking a quantity.
    await handleUserMessage(PHONE, { type: 'text', text: 'MENU' }, env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), 'Drinks'), env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), 'Bottled Water'), env);

    // Bottled Water detail → Choose Qty → tap 2
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'qty_custom_9', title: 'Choose Qty' }, env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), '2'), env);

    const cart = await readCart(kv);
    assert.deepEqual(
      cart.map(l => [l.name, l.qty]),
      [['Fried Rice', 1], ['Bottled Water', 2]],
      'the tapped item must be added; the old cart line must not be touched'
    );
    assert.match(bodyOf(lastSent(sent)), /Bottled Water/);
  } finally {
    restore();
  }
});

// Same journey, but the quantity is TYPED instead of tapped — free text
// carries no id, so this one is only safe if the stale edit intent was
// cleared when the user opened a menu item.
test('abandoned cart qty-edit does not hijack a typed quantity', async () => {
  const { env, kv, sent, restore } = makeEnv({
    session: { state: 'cart_review', adminCtx: {} },
    cart: [{ itemId: 1, name: 'Fried Rice', qty: 1, unitPrice: 3500, notes: '' }],
  });

  try {
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'btn_manage_cart', title: 'Manage' }, env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), 'Fried Rice (x1)'), env);
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'cart_item_qty', title: 'Change Qty' }, env);

    await handleUserMessage(PHONE, { type: 'text', text: 'MENU' }, env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), 'Drinks'), env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), 'Bottled Water'), env);
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'qty_custom_9', title: 'Choose Qty' }, env);
    await handleUserMessage(PHONE, { type: 'text', text: '3' }, env);

    const cart = await readCart(kv);
    assert.deepEqual(
      cart.map(l => [l.name, l.qty]),
      [['Fried Rice', 1], ['Bottled Water', 3]]
    );
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────
// Cause 2 — a stale KV read must not beat the id in the tap
// ─────────────────────────────────────────────────────────────

test('Add 1 adds the item embedded in the button, not a stale tempItemId', async () => {
  // KV hands back a session still pointing at the previously viewed item.
  const { env, kv, sent, restore } = makeEnv({
    session: { state: 'item_detail', adminCtx: {}, tempItemId: 1 },
    cart: [],
  });

  try {
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'qty_1_9', title: 'Add 1' }, env);

    const cart = await readCart(kv);
    assert.deepEqual(cart.map(l => l.name), ['Bottled Water']);
    assert.match(bodyOf(lastSent(sent)), /Bottled Water/);
  } finally {
    restore();
  }
});

test('a tapped quantity carries its item id even when the session is stale', async () => {
  const { env, kv, sent, restore } = makeEnv({
    session: { state: 'item_detail', adminCtx: {}, tempItemId: 9 },
    cart: [],
  });

  try {
    // Render the quantity list for Bottled Water…
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'qty_custom_9', title: 'Choose Qty' }, env);
    const pick = tapRow(lastSent(sent), '4');

    // …then have KV regress to a session pointing at the other item.
    await env.SESSION_KV.put(
      `session:${PHONE}`,
      JSON.stringify({ state: 'entering_quantity', adminCtx: {}, tempItemId: 1 })
    );

    await handleUserMessage(PHONE, pick, env);

    const cart = await readCart(kv);
    assert.deepEqual(cart.map(l => [l.name, l.qty]), [['Bottled Water', 4]]);
  } finally {
    restore();
  }
});

// Row "1" of the quantity list is `qty_1_{itemId}` — the same shape as the
// "Add 1" button, so it routes through the item-detail handler. Cover it.
test('picking 1 from the quantity list adds exactly one of that item', async () => {
  const { env, kv, sent, restore } = makeEnv({
    session: { state: 'item_detail', adminCtx: {}, tempItemId: 9 },
    cart: [],
  });

  try {
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'qty_custom_9', title: 'Choose Qty' }, env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), '1'), env);

    assert.deepEqual((await readCart(kv)).map(l => [l.name, l.qty]), [['Bottled Water', 1]]);
  } finally {
    restore();
  }
});

// Every quantity row names its target, so a session with no target must bail
// rather than re-prompt with rows that name nothing (an unbreakable loop).
test('a quantity prompt with no target bails instead of looping', async () => {
  const { env, sent, restore } = makeEnv({
    session: { state: 'entering_quantity', adminCtx: {}, tempItemId: null },
    cart: [],
  });

  try {
    await handleUserMessage(PHONE, { type: 'text', text: 'two please' }, env);

    const msg = lastSent(sent);
    assert.equal(msg.type, 'text', 'must not re-render the quantity list');
    assert.match(bodyOf(msg), /MENU/);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────
// The cart-edit flow itself must keep working
// ─────────────────────────────────────────────────────────────

test('cart qty-edit still updates the selected line', async () => {
  const { env, kv, sent, restore } = makeEnv({
    session: { state: 'cart_review', adminCtx: {} },
    cart: [
      { itemId: 1, name: 'Fried Rice', qty: 1, unitPrice: 3500, notes: '' },
      { itemId: 9, name: 'Bottled Water', qty: 1, unitPrice: 500, notes: '' },
    ],
  });

  try {
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'btn_manage_cart', title: 'Manage' }, env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), 'Bottled Water (x1)'), env);
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'cart_item_qty', title: 'Change Qty' }, env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), '6'), env);

    const cart = await readCart(kv);
    assert.deepEqual(
      cart.map(l => [l.name, l.qty]),
      [['Fried Rice', 1], ['Bottled Water', 6]],
      'only the line the user opened may change'
    );
  } finally {
    restore();
  }
});

test('a stale cart qty-edit tap mutates nothing when the line moved', async () => {
  const { env, kv, sent, restore } = makeEnv({
    session: { state: 'cart_review', adminCtx: {} },
    cart: [
      { itemId: 1, name: 'Fried Rice', qty: 1, unitPrice: 3500, notes: '' },
      { itemId: 9, name: 'Bottled Water', qty: 1, unitPrice: 500, notes: '' },
    ],
  });

  try {
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'btn_manage_cart', title: 'Manage' }, env);
    await handleUserMessage(PHONE, tapRow(lastSent(sent), 'Bottled Water (x1)'), env);
    await handleUserMessage(PHONE, { type: 'button_reply', id: 'cart_item_qty', title: 'Change Qty' }, env);
    const pick = tapRow(lastSent(sent), '6');

    // The cart shrank before the tap landed — index 1 no longer exists.
    await env.SESSION_KV.put(
      `cart:${PHONE}`,
      JSON.stringify([{ itemId: 1, name: 'Fried Rice', qty: 1, unitPrice: 3500, notes: '' }])
    );

    await handleUserMessage(PHONE, pick, env);

    const cart = await readCart(kv);
    assert.deepEqual(cart.map(l => [l.name, l.qty]), [['Fried Rice', 1]],
      'a stale target must be dropped, never applied to whatever now sits there');
  } finally {
    restore();
  }
});
