/**
 * tests/session.test.mjs — cart isolation + KV change-detection.
 *
 * Regression target (BUG-09 / "cart loss"): the cart lives on its OWN KV
 * key and saveSession writes it ONLY when it actually changed. A navigation
 * tap that re-persisted a STALE (empty) cart used to clobber items added
 * moments earlier. These tests pin both behaviours down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getSession,
  saveSession,
  addToCart,
  cartTotal,
} from '../src/session.js';
import { makeKV } from './helpers.mjs';

const PHONE = '2348000000001';

test('two adds accumulate into the same cart key', async () => {
  const env = { SESSION_KV: makeKV() };

  // First add.
  let s = await getSession(PHONE, env);
  addToCart(s.cart, { itemId: 1, name: 'Jollof', qty: 1, unitPrice: 2500, notes: '' });
  await saveSession(PHONE, s, env);

  // Second add (fresh load, like a new webhook request).
  s = await getSession(PHONE, env);
  assert.equal(s.cart.length, 1, 'first item should have persisted');
  addToCart(s.cart, { itemId: 2, name: 'Chicken', qty: 2, unitPrice: 1500, notes: '' });
  await saveSession(PHONE, s, env);

  // Reload and confirm both lines are present and totalled correctly.
  s = await getSession(PHONE, env);
  assert.equal(s.cart.length, 2);
  assert.equal(cartTotal(s.cart), 2500 + 1500 * 2);
});

test('same item + same notes merges qty; different notes stays separate', async () => {
  const env = { SESSION_KV: makeKV() };
  let s = await getSession(PHONE, env);
  addToCart(s.cart, { itemId: 1, name: 'Burger', qty: 1, unitPrice: 1000, notes: '' });
  addToCart(s.cart, { itemId: 1, name: 'Burger', qty: 2, unitPrice: 1000, notes: '' });
  addToCart(s.cart, { itemId: 1, name: 'Burger', qty: 1, unitPrice: 1000, notes: 'no onions' });
  await saveSession(PHONE, s, env);

  s = await getSession(PHONE, env);
  assert.equal(s.cart.length, 2, 'merge by (itemId, notes)');
  const plain = s.cart.find(i => i.notes === '');
  const custom = s.cart.find(i => i.notes === 'no onions');
  assert.equal(plain.qty, 3);
  assert.equal(custom.qty, 1);
});

test('cart is stored on its own key, not inside the session blob', async () => {
  const env = { SESSION_KV: makeKV() };
  const s = await getSession(PHONE, env);
  addToCart(s.cart, { itemId: 9, name: 'Fries', qty: 1, unitPrice: 800, notes: '' });
  await saveSession(PHONE, s, env);

  const sessionRaw = env.SESSION_KV.store.get(`session:${PHONE}`);
  const cartRaw = env.SESSION_KV.store.get(`cart:${PHONE}`);
  const sessionObj = JSON.parse(sessionRaw);

  assert.ok(cartRaw, 'cart key must exist');
  assert.ok(!('cart' in sessionObj), 'session blob must NOT carry the cart');
  assert.ok(!('__cartBaseline' in sessionObj), 'baseline marker must not be persisted');
  assert.deepEqual(JSON.parse(cartRaw)[0].name, 'Fries');
});

test('navigation save (cart unchanged) does NOT write the cart key', async () => {
  const env = { SESSION_KV: makeKV() };

  // Seed a cart.
  let s = await getSession(PHONE, env);
  addToCart(s.cart, { itemId: 1, name: 'Rice', qty: 1, unitPrice: 1200, notes: '' });
  await saveSession(PHONE, s, env);

  // A navigation request: load session, change only non-cart state, save.
  s = await getSession(PHONE, env);
  let cartWrites = 0;
  const realPut = env.SESSION_KV.put.bind(env.SESSION_KV);
  env.SESSION_KV.put = async (key, value, opts) => {
    if (key === `cart:${PHONE}`) cartWrites += 1;
    return realPut(key, value, opts);
  };

  s.state = 'browsing';
  s.tempCategoryId = 5; // navigation, cart untouched
  await saveSession(PHONE, s, env);

  assert.equal(cartWrites, 0, 'unchanged cart must not be re-written');
});

test('STALE navigation read does not clobber a concurrently-added item', async () => {
  // Models the original bug precisely: request A adds an item and commits.
  // request B started from a STALE (empty) snapshot of the session blob,
  // navigates, and saves. Because the cart is on its own key and B never
  // touched the cart, B's save must leave A's item intact.
  const env = { SESSION_KV: makeKV() };

  // Request B loads first (sees empty cart) but hasn't saved yet.
  const sessionB = await getSession(PHONE, env);
  assert.equal(sessionB.cart.length, 0);

  // Request A: add item and commit.
  const sessionA = await getSession(PHONE, env);
  addToCart(sessionA.cart, { itemId: 7, name: 'Suya', qty: 1, unitPrice: 3000, notes: '' });
  await saveSession(PHONE, sessionA, env);

  // Request B now finishes its navigation save with its STALE empty cart.
  sessionB.state = 'browsing';
  sessionB.tempItemId = 7;
  await saveSession(PHONE, sessionB, env);

  // The committed cart must still contain A's item — B's stale empty cart
  // had the same baseline (empty), so change-detection skipped the write.
  const final = await getSession(PHONE, env);
  assert.equal(final.cart.length, 1, 'stale navigation must not wipe the cart');
  assert.equal(final.cart[0].name, 'Suya');
});
