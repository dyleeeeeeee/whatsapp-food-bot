/**
 * tests/menu-pagination.test.mjs — menu list pagination invariants.
 *
 * Regression target: WhatsApp caps a list at 10 TOTAL rows and silently drops
 * the overflow. With 9 items/page a middle page rendered 9 items + Previous +
 * Next = 11 rows, so the 11th row (Next) was dropped and users could never
 * advance past page 2. These tests pin the row budget and nav correctness.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMenuListRows } from '../src/handlers/user.js';

const CAT = 5;
const mkItems = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `Item ${i + 1}`,
    price: 1000 + i,
    description: 'desc',
  }));

const navRow = (rows, prefix) => rows.find(r => r.id.startsWith(prefix));

test('every page stays within the 10-row WhatsApp cap', () => {
  for (const count of [1, 7, 8, 15, 30, 63]) {
    const items = mkItems(count);
    const totalPages = Math.max(1, Math.ceil(count / 7));
    for (let p = 0; p < totalPages; p++) {
      const { rows } = buildMenuListRows(items, CAT, p);
      assert.ok(rows.length <= 10, `count=${count} page=${p} produced ${rows.length} rows`);
    }
  }
});

test('a middle page shows BOTH Previous and Next (the old bug)', () => {
  const items = mkItems(15); // 3 pages: 7, 7, 1
  const { rows } = buildMenuListRows(items, CAT, 1);

  assert.equal(rows.length, 10, '7 items + Prev + Next + Categories');
  assert.ok(navRow(rows, 'page_prev_'), 'Previous row present');
  assert.ok(navRow(rows, 'page_next_'), 'Next row present — was dropped before the fix');
  assert.equal(navRow(rows, 'page_next_').id, `page_next_${CAT}_2`, 'Next targets page index 2');
  assert.equal(navRow(rows, 'page_prev_').id, `page_prev_${CAT}_0`, 'Previous targets page index 0');
});

test('first page has Next but no Previous', () => {
  const { rows } = buildMenuListRows(mkItems(15), CAT, 0);
  assert.equal(navRow(rows, 'page_prev_'), undefined);
  assert.ok(navRow(rows, 'page_next_'));
});

test('last page has Previous but no Next (no greyed-out button exists)', () => {
  const { rows } = buildMenuListRows(mkItems(15), CAT, 2);
  assert.ok(navRow(rows, 'page_prev_'));
  assert.equal(navRow(rows, 'page_next_'), undefined);
});

test('a single-page category shows no pagination rows', () => {
  const { rows, totalPages } = buildMenuListRows(mkItems(5), CAT, 0);
  assert.equal(totalPages, 1);
  assert.equal(navRow(rows, 'page_prev_'), undefined);
  assert.equal(navRow(rows, 'page_next_'), undefined);
});

test('the Categories escape row is present on every page', () => {
  const items = mkItems(15);
  for (let p = 0; p < 3; p++) {
    const { rows } = buildMenuListRows(items, CAT, p);
    assert.ok(rows.some(r => r.id === 'cmd_menu'), `page ${p} has Categories row`);
  }
});

test('an out-of-range page clamps to the last valid page', () => {
  const items = mkItems(15); // 3 pages (indices 0..2)
  const { rows, page } = buildMenuListRows(items, CAT, 99);
  assert.equal(page, 2, 'clamped to last page');
  assert.ok(rows.some(r => r.id.startsWith('item_')), 'renders items, not an empty list');
  assert.equal(navRow(rows, 'page_next_'), undefined, 'last page has no Next');
});

test('item rows carry the item id and a price-prefixed description', () => {
  const { rows } = buildMenuListRows(mkItems(3), CAT, 0);
  const first = rows[0];
  assert.equal(first.id, 'item_1');
  assert.ok(first.description.startsWith('₦'));
});
