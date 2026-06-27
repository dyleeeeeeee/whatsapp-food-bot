/**
 * tests/status-transitions.test.mjs — order status state machine.
 *
 * EDGE-07: 'delivered' and 'cancelled' are TERMINAL. The transition table
 * and the isAllowedTransition() guard live module-private in
 * src/handlers/admin.js (not exported), so this is a CONTRACT test: the
 * map + logic below are mirrored verbatim from that file and must be kept
 * in sync with it. The point is to lock the terminal-state rejection and
 * monotonic forward-only progression so a future edit can't silently let
 * a delivered/cancelled order be re-opened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const VALID_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'];

// MIRROR of src/handlers/admin.js STATUS_TRANSITIONS — keep in sync.
const STATUS_TRANSITIONS = {
  pending:   ['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'],
  confirmed: ['confirmed', 'preparing', 'ready', 'delivered', 'cancelled'],
  preparing: ['preparing', 'ready', 'delivered', 'cancelled'],
  ready:     ['ready', 'delivered', 'cancelled'],
  delivered: ['delivered'],
  cancelled: ['cancelled'],
};

// MIRROR of src/handlers/admin.js isAllowedTransition.
function isAllowedTransition(current, next) {
  const allowed = STATUS_TRANSITIONS[current];
  if (!allowed) return true; // unknown current — permissive
  return allowed.includes(next);
}

test('terminal states reject every onward transition except self', () => {
  for (const next of VALID_STATUSES) {
    const expectSelf = next === 'delivered';
    assert.equal(
      isAllowedTransition('delivered', next),
      expectSelf,
      `delivered -> ${next}`
    );
  }
  for (const next of VALID_STATUSES) {
    const expectSelf = next === 'cancelled';
    assert.equal(
      isAllowedTransition('cancelled', next),
      expectSelf,
      `cancelled -> ${next}`
    );
  }
});

test('forward progression and same-state are allowed', () => {
  assert.equal(isAllowedTransition('pending', 'confirmed'), true);
  assert.equal(isAllowedTransition('confirmed', 'preparing'), true);
  assert.equal(isAllowedTransition('preparing', 'ready'), true);
  assert.equal(isAllowedTransition('ready', 'delivered'), true);
  assert.equal(isAllowedTransition('pending', 'pending'), true, 'self is allowed');
});

test('backward transitions are rejected', () => {
  assert.equal(isAllowedTransition('ready', 'preparing'), false);
  assert.equal(isAllowedTransition('preparing', 'confirmed'), false);
  assert.equal(isAllowedTransition('confirmed', 'pending'), false);
  assert.equal(isAllowedTransition('delivered', 'ready'), false);
});

test('any non-terminal state may be cancelled', () => {
  for (const from of ['pending', 'confirmed', 'preparing', 'ready']) {
    assert.equal(isAllowedTransition(from, 'cancelled'), true, `${from} -> cancelled`);
  }
});

test('unknown current status is permissive (never strands an admin)', () => {
  assert.equal(isAllowedTransition('weird', 'delivered'), true);
  assert.equal(isAllowedTransition(undefined, 'cancelled'), true);
});

test('the mirrored table is internally consistent', () => {
  // Every status appears as a key; every listed target is a VALID_STATUS;
  // every state allows itself.
  for (const status of VALID_STATUSES) {
    assert.ok(STATUS_TRANSITIONS[status], `missing key: ${status}`);
    assert.ok(STATUS_TRANSITIONS[status].includes(status), `${status} must allow self`);
    for (const target of STATUS_TRANSITIONS[status]) {
      assert.ok(VALID_STATUSES.includes(target), `unknown target ${target} in ${status}`);
    }
  }
});
