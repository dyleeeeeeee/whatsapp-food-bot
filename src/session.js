/**
 * src/session.js — KV-Backed Session & State Machine
 *
 * BUG-06: cartTotal uses integer-cent arithmetic to eliminate float errors.
 * BUG-15: Removed dead MENU_CACHE_TTL module constant (env var is the source
 *         of truth; the constant was never referenced).
 * BUG-30: cartSummary caps item name at 40 chars to avoid runaway line lengths.
 *
 * KV key layout:
 *   session:{phone}  → session JSON                TTL: 2h
 *   menu:cache       → serialised full menu JSON   TTL: configurable (default 5m)
 *   admin:{phone}    → '1' or '0'                  TTL: 60s
 *   dedup:{wamid}    → '1'                         TTL: 1h
 */

const SESSION_TTL = 60 * 60 * 2; // 2 hours in seconds

// Currency configuration
export const CURRENCY_SYMBOL = '₦';
export const MAX_PRICE = 999.99; // Maximum allowed price for items

/**
 * Format a price amount with the currency symbol.
 * @param {number} amount - Price amount
 * @returns {string} Formatted price like "₦9.99"
 */
export function formatPrice(amount) {
  return `${CURRENCY_SYMBOL}${Number(amount).toFixed(2)}`;
}

// ─────────────────────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────────────────────

function sessionKey(phone) {
  return `session:${phone}`;
}

/** Load session from KV; return a fresh default if missing or corrupt */
export async function getSession(phone, env) {
  const raw = await env.SESSION_KV.get(sessionKey(phone));
  if (raw) {
    try { return JSON.parse(raw); } catch { /* corrupt — fall through */ }
  }
  return defaultSession();
}

/** Persist session to KV, resetting the 2-hour TTL */
export async function saveSession(phone, session, env) {
  await env.SESSION_KV.put(
    sessionKey(phone),
    JSON.stringify(session),
    { expirationTtl: SESSION_TTL }
  );
}

/** Delete session on order complete or explicit cancel */
export async function clearSession(phone, env) {
  await env.SESSION_KV.delete(sessionKey(phone));
}

function defaultSession() {
  return {
    state:      'idle',
    cart:       [],    // [{ itemId, name, qty, unitPrice, notes }]
    adminCtx:   {},    // scratch space for admin multi-step flows
    tempItemId: null,  // item being viewed/added
    tempQty:    null,
  };
}

// ─────────────────────────────────────────────────────────────
// Cart helpers
// ─────────────────────────────────────────────────────────────

/**
 * Sum the cart total in integer cents to avoid IEEE 754 drift,
 * then convert back to a rounded dollar amount.
 *
 * BUG-06 FIX: Previously used direct float multiplication:
 *   cart.reduce((sum, i) => sum + i.unitPrice * i.qty, 0)
 * which produced results like 34.169999999999995 stored to D1.
 */
export function cartTotal(cart) {
  const cents = cart.reduce(
    (sum, i) => sum + Math.round(i.unitPrice * 100) * i.qty,
    0
  );
  return Math.round(cents) / 100;
}

/**
 * Human-readable cart summary for WhatsApp messages.
 *
 * BUG-30 FIX: Item names capped at 40 chars in display to prevent
 * excessively wide lines from 100-char DB names blowing message limits.
 */
export function cartSummary(cart) {
  if (!cart.length) return '_Your cart is empty._';
  const lines = cart.map(i => {
    const displayName = i.name.length > 40 ? i.name.slice(0, 37) + '…' : i.name;
    return `• ${displayName} ×${i.qty}  ${formatPrice(Math.round(i.unitPrice * 100) * i.qty / 100)}`;
  });
  lines.push(`\n*Total: ${formatPrice(cartTotal(cart))}*`);
  return lines.join('\n');
}

/**
 * Add item to cart. Items with the same ID but DIFFERENT notes are kept
 * separate to allow "Burger with no onions" and "Burger with extra cheese".
 *
 * CRITICAL FIX: Previously merged by itemId only, losing different notes.
 */
export function addToCart(cart, item) {
  const existing = cart.find(
    i => i.itemId === item.itemId && i.notes === item.notes
  );
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
    try { return JSON.parse(raw); } catch { /* corrupt cache — refetch */ }
  }
  return null;
}

export async function cacheMenu(menu, env) {
  // BUG-15 FIX: env var is the only source of truth for TTL.
  // The now-removed module constant MENU_CACHE_TTL was never referenced.
  const ttl = Math.max(60, parseInt(env.MENU_CACHE_TTL || '300', 10));
  await env.SESSION_KV.put('menu:cache', JSON.stringify(menu), {
    expirationTtl: ttl,
  });
}

export async function bustMenuCache(env) {
  await env.SESSION_KV.delete('menu:cache');
}
