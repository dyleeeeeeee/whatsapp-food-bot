/**
 * src/session.js — KV-Backed Session & State Machine
 *
 * State machine states:
 *   idle | browsing_menu | selecting_item | entering_quantity
 *   entering_notes | checkout_address | checkout_confirm | admin_mode
 *   admin_add_item_* | admin_edit_item_* | admin_update_status
 *
 * KV key layout:
 *   session:{phone}   → { state, cart, adminCtx, ...temp }  TTL: 2h
 *   menu:cache        → serialised menu                      TTL: 5min
 */

const SESSION_TTL = 60 * 60 * 2;      // 2 hours (seconds)
const MENU_CACHE_TTL = 60 * 5;        // 5 minutes

// ─────────────────────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────────────────────

function sessionKey(phone) {
  return `session:${phone}`;
}

/** Load session from KV, return default if missing */
export async function getSession(phone, env) {
  const raw = await env.SESSION_KV.get(sessionKey(phone));
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  return defaultSession();
}

/** Persist session back to KV */
export async function saveSession(phone, session, env) {
  await env.SESSION_KV.put(
    sessionKey(phone),
    JSON.stringify(session),
    { expirationTtl: SESSION_TTL }
  );
}

/** Wipe session (order complete, or timeout) */
export async function clearSession(phone, env) {
  await env.SESSION_KV.delete(sessionKey(phone));
}

function defaultSession() {
  return {
    state: 'idle',
    cart: [],          // [{ itemId, name, qty, unitPrice, notes }]
    adminCtx: {},      // temp data for admin multi-step flows
    tempItemId: null,  // item being selected
    tempQty: null,
  };
}

// ─────────────────────────────────────────────────────────────
// Cart helpers
// ─────────────────────────────────────────────────────────────

export function cartTotal(cart) {
  return cart.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
}

export function cartSummary(cart) {
  if (!cart.length) return '_Your cart is empty._';
  const lines = cart.map(
    i => `• ${i.name} ×${i.qty}  $${(i.unitPrice * i.qty).toFixed(2)}`
  );
  lines.push(`\n*Total: $${cartTotal(cart).toFixed(2)}*`);
  return lines.join('\n');
}

export function addToCart(cart, item) {
  const existing = cart.find(i => i.itemId === item.itemId);
  if (existing) {
    existing.qty += item.qty;
  } else {
    cart.push({ ...item });
  }
  return cart;
}

export function clearCart(session) {
  session.cart = [];
  return session;
}

// ─────────────────────────────────────────────────────────────
// Menu cache
// ─────────────────────────────────────────────────────────────

export async function getCachedMenu(env) {
  const raw = await env.SESSION_KV.get('menu:cache');
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  return null;
}

export async function cacheMenu(menu, env) {
  const ttl = parseInt(env.MENU_CACHE_TTL || '300', 10);
  await env.SESSION_KV.put('menu:cache', JSON.stringify(menu), {
    expirationTtl: ttl,
  });
}

export async function bustMenuCache(env) {
  await env.SESSION_KV.delete('menu:cache');
}
