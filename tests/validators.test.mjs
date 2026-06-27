/**
 * tests/validators.test.mjs — money + input validators.
 *
 * parsePrice (src/session.js) and isValidImageUrl / hasMinAlphaNum
 * (src/security.js) guard money and admin input. They are pure, so we
 * exercise them directly with boundary + adversarial inputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePrice, MAX_PRICE } from '../src/session.js';
import { isValidImageUrl, hasMinAlphaNum } from '../src/security.js';

test('parsePrice accepts plain and grouped/symbol-prefixed amounts', () => {
  assert.equal(parsePrice('100'), 100);
  assert.equal(parsePrice('1234.5'), 1234.5);
  assert.equal(parsePrice('1234.56'), 1234.56);
  assert.equal(parsePrice('₦1,234.50'), 1234.5);
  assert.equal(parsePrice('  2,000  '), 2000);
});

test('parsePrice rejects junk, non-strings, and >2 decimals', () => {
  assert.equal(parsePrice('abc'), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('1.234'), null, 'more than 2 decimals');
  assert.equal(parsePrice('12.'), null);
  assert.equal(parsePrice('-5'), null);
  assert.equal(parsePrice('1e3'), null);
  assert.equal(parsePrice(100), null, 'non-string');
  assert.equal(parsePrice(null), null);
});

test('parsePrice enforces the (0, MAX_PRICE] range', () => {
  assert.equal(parsePrice('0'), null, 'zero is not > 0');
  assert.equal(parsePrice('0.00'), null);
  assert.equal(parsePrice(String(MAX_PRICE)), MAX_PRICE, 'ceiling is inclusive');
  assert.equal(parsePrice(String(MAX_PRICE + 1)), null, 'over ceiling rejected');
});

test('isValidImageUrl accepts a real HTTPS CDN url', () => {
  assert.equal(isValidImageUrl('https://cdn.example.com/img/burger.jpg'), true);
  assert.equal(isValidImageUrl('https://images.example.co/photo'), true, 'extension not required');
});

test('isValidImageUrl rejects non-https, localhost, IPs, and junk', () => {
  assert.equal(isValidImageUrl('http://cdn.example.com/x.jpg'), false, 'http not allowed');
  assert.equal(isValidImageUrl('https://localhost/x.jpg'), false);
  assert.equal(isValidImageUrl('https://127.0.0.1/x.jpg'), false);
  assert.equal(isValidImageUrl('https://example'), false, 'no TLD');
  assert.equal(isValidImageUrl('not a url'), false);
  assert.equal(isValidImageUrl('https://x.y'), false, 'too short (<12 chars)');
  assert.equal(isValidImageUrl(null), false);
  assert.equal(isValidImageUrl('https://[::1]/x.jpg'), false, 'ipv6 literal');
});

test('hasMinAlphaNum requires >= n alphanumeric chars (default 3)', () => {
  assert.equal(hasMinAlphaNum('abc'), true);
  assert.equal(hasMinAlphaNum('a1b'), true);
  assert.equal(hasMinAlphaNum('ab'), false, 'only 2 alnum');
  assert.equal(hasMinAlphaNum('!!! ☺☺☺'), false, 'punctuation/emoji only');
  assert.equal(hasMinAlphaNum('Jollof Rice'), true);
  assert.equal(hasMinAlphaNum('ab', 2), true, 'custom n');
  assert.equal(hasMinAlphaNum('', 1), false);
  assert.equal(hasMinAlphaNum(null), false);
});
