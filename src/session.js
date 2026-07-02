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
export const MAX_PRICE = 1000000; // Maximum allowed price for items (₦1,000,000 ceiling)

/**
 * Format a price amount with the currency symbol, using NGN locale
 * grouping (e.g. "₦1,234" / "₦1,234.5"). Fraction digits 0–2: whole
 * Naira render with no decimals, kobo amounts keep up to 2 places.
 * @param {number} amount - Price amount
 * @returns {string} Formatted price like "₦1,234.56"
 */
export function formatPrice(amount) {
  return `${CURRENCY_SYMBOL}${Number(amount).toLocaleString('en-NG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Parse a user-supplied price string into a Number.
 * Strips the currency symbol, commas and spaces, then requires a plain
 * decimal with at most 2 fraction digits. Returns the Number only when it
 * is > 0 and <= MAX_PRICE; otherwise null.
 * @param {string} str - Raw price input (e.g. "₦1,234.50")
 * @returns {number|null} Parsed price, or null if invalid/out of range
 */
export function parsePrice(str) {
  if (typeof str !== 'string') return null;
  const cleaned = str.replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (value > 0 && value <= MAX_PRICE) return value;
  return null;
}

// ─────────────────────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────────────────────

function sessionKey(phone) {
  return `session:${phone}`;
}

// CART-LOSS FIX (BUG-09): the cart lives in its OWN KV key, separate from the
// session blob. Every navigation tap (browse category, open item, …) does a
// read-modify-write of the session blob; on KV's eventually-consistent reads
// that re-persisted a STALE (empty) cart, wiping items added moments earlier —
// so the cart appeared to only ever hold one item. By storing the cart on its
// own key and writing it ONLY when it actually changed (change-detection in
// saveSession), navigation saves never touch — and never clobber — the cart.
function cartKey(phone) {
  return `cart:${phone}`;
}

/** Load session from KV; return a fresh default if missing or corrupt. */
export async function getSession(phone, env) {
  const raw = await env.SESSION_KV.get(sessionKey(phone));
  let session = defaultSession();
  if (raw) {
    try { session = JSON.parse(raw); } catch { /* corrupt — keep default */ }
  }

  // Load the cart from its dedicated key (source of truth for the cart).
  const cartRaw = await env.SESSION_KV.get(cartKey(phone));
  let cart;
  if (cartRaw) {
    try { cart = JSON.parse(cartRaw); } catch { cart = []; }
  } else if (Array.isArray(session.cart) && session.cart.length) {
    // One-time migration: a legacy session that still has the cart inline.
    cart = session.cart;
  } else {
    cart = [];
  }
  session.cart = Array.isArray(cart) ? cart : [];

  // Baseline lets saveSession write the cart key ONLY when it changed.
  session.__cartBaseline = JSON.stringify(session.cart);
  return session;
}

/** Persist session to KV, resetting the 2-hour TTL. */
// BUG-20 policy note: every save SLIDES the 2h TTL — an active user's
// session stays alive as long as they keep interacting; it only expires
// after 2h of inactivity.
export async function saveSession(phone, session, env) {
  // Write the cart to its own key ONLY when it actually changed this request.
  // Navigation taps don't change the cart, so they never write (or clobber) it.
  const currentCart = JSON.stringify(session.cart || []);
  if (currentCart !== session.__cartBaseline) {
    await env.SESSION_KV.put(cartKey(phone), currentCart, { expirationTtl: SESSION_TTL });
    session.__cartBaseline = currentCart;
  }

  // The session blob never carries the cart (or the internal baseline marker).
  const { cart, __cartBaseline, ...rest } = session;
  await env.SESSION_KV.put(
    sessionKey(phone),
    JSON.stringify(rest),
    { expirationTtl: SESSION_TTL }
  );
}

/** Delete session AND cart on order complete or explicit cancel. */
export async function clearSession(phone, env) {
  await env.SESSION_KV.delete(sessionKey(phone));
  await env.SESSION_KV.delete(cartKey(phone));
}

function defaultSession() {
  return {
    state:            'idle',
    cart:             [],    // [{ itemId, name, qty, unitPrice, notes }]
    adminCtx:         {},    // scratch space for admin multi-step flows
    tempItemId:       null,  // item being viewed/added
    tempQty:          null,
    tempCategoryId:   null,  // category user last browsed (for back navigation)
    tempCategoryName: null,
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
 * FastChow service fee. Charged on top of the item subtotal:
 * subtotal of ₦5,000 or more → ₦1,000, anything below → ₦600.
 * Single source of truth — used at checkout display, the charged
 * amount, and the persisted order total so all three always agree.
 * @param {number} subtotal - Item subtotal (before fee), in Naira
 * @returns {number} Fee in Naira
 */
export function serviceFee(subtotal) {
  return subtotal >= 5000 ? 1000 : 600;
}

/**
 * Grand total the customer pays: item subtotal + service fee.
 * @param {Array} cart
 * @returns {number} Total in Naira
 */
export function orderTotal(cart) {
  const subtotal = cartTotal(cart);
  return subtotal + serviceFee(subtotal);
}

/**
 * Human-readable cart summary for WhatsApp messages.
 *
 * BUG-30 FIX: Item names capped at 40 chars in display to prevent
 * excessively wide lines from 100-char DB names blowing message limits.
 */
export function cartSummary(cart, { withTotal = true } = {}) {
  if (!cart.length) return '_Your cart is empty._';
  const lines = cart.map(i => {
    const displayName = i.name.length > 40 ? i.name.slice(0, 37) + '…' : i.name;
    return `• ${displayName} ×${i.qty}  ${formatPrice(Math.round(i.unitPrice * 100) * i.qty / 100)}`;
  });
  // Checkout confirm renders its own subtotal/fee/total breakdown, so it
  // passes withTotal:false to avoid a duplicate (and misleading) total line.
  if (withTotal) lines.push(`\n*Total: ${formatPrice(cartTotal(cart))}*`);
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
    // BUG-18 note: merging keeps the FIRST line's unitPrice — if the menu
    // price changed between the two adds, this stale price persists here.
    // Callers MUST refresh each line's price at checkout (fully fixed in
    // user.js, which re-reads live menu prices before payment).
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
