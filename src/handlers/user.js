/**
 * src/handlers/user.js — Customer Conversation State Machine
 *
 * BUG-01 FIX: getCachedMenu and cacheMenu are imported from session.js
 *             (where they live), not from db.js (which does not export them).
 *             This was the #1 critical bug — menu browsing was dead on arrival.
 *
 * BUG-07 FIX: showMenuCategories guards against empty category list.
 * BUG-08 FIX: Checkout confirm body is capped to stay under 1024 chars.
 * BUG-16 FIX: Dead cmd_checkout branch removed from handleBrowsingMenu.
 * BUG-17 FIX: showWelcome dead export removed.
 * BUG-28 FIX: showItemDetail uses imageButtonPayload (single message),
 *             not sendImage + sendButtons (two messages, two API calls).
 * BUG-29 FIX: showCart skips the KV write when state is already cart_review.
 *
 * States:
 *   idle | browsing_menu | selecting_item | item_detail
 *   entering_quantity | entering_notes | cart_review
 *   checkout_address | checkout_confirm
 */

import {
  sendText, sendButtons, sendList, sendImageButtons,
} from '../whatsapp.js';
import {
  getSession, saveSession,
  addToCart, cartSummary, cartTotal, clearCart,
  getCachedMenu,  // BUG-01 FIX: was wrongly imported from db.js
  cacheMenu,      // BUG-01 FIX: was wrongly imported from db.js
} from '../session.js';
import {
  getFullMenu, getMenuItem, createOrder, getUserOrders,
} from '../db.js';
import { sanitize } from '../security.js';

// Maximum chars in checkout confirm body (WhatsApp cap: 1024)
const CONFIRM_BODY_MAX = 900;

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export async function handleUserMessage(phone, msg, env) {
  const session = await getSession(phone, env);

  // Global shortcuts intercept first, regardless of state
  if (isGlobalCommand(msg)) {
    return handleGlobalCommand(phone, msg, session, env);
  }

  switch (session.state) {
    case 'idle':             return handleIdle(phone, msg, session, env);
    case 'browsing_menu':    return handleBrowsingMenu(phone, msg, session, env);
    case 'selecting_item':   return handleSelectingItem(phone, msg, session, env);
    case 'item_detail':      return handleItemDetail(phone, msg, session, env);
    case 'entering_quantity':return handleEnteringQuantity(phone, msg, session, env);
    case 'entering_notes':   return handleEnteringNotes(phone, msg, session, env);
    case 'cart_review':      return handleCartReview(phone, msg, session, env);
    case 'checkout_address': return handleCheckoutAddress(phone, msg, session, env);
    case 'checkout_confirm': return handleCheckoutConfirm(phone, msg, session, env);
    default:
      return handleIdle(phone, msg, session, env);
  }
}

// ─────────────────────────────────────────────────────────────
// Global commands — active in every state
// ─────────────────────────────────────────────────────────────

function isGlobalCommand(msg) {
  const t = (msg.text || '').toUpperCase().trim();
  return (
    t === 'MENU'   || t === 'START'  || t === 'HI' || t === 'HELLO' ||
    t === 'CART'   || t === 'ORDERS' || t === 'CANCEL' ||
    msg.id === 'cmd_menu'   || msg.id === 'cmd_cart' ||
    msg.id === 'cmd_cancel' || msg.id === 'cmd_orders'
  );
}

async function handleGlobalCommand(phone, msg, session, env) {
  const t  = (msg.text || '').toUpperCase().trim();
  const id = msg.id || '';

  if (t === 'CANCEL' || id === 'cmd_cancel') {
    clearCart(session);
    session.state = 'idle';
    await saveSession(phone, session, env);
    return sendText(phone, '🚫 Order cancelled. Send *MENU* to start again.', env);
  }

  if (t === 'CART' || id === 'cmd_cart') {
    return showCart(phone, session, env);
  }

  if (t === 'ORDERS' || id === 'cmd_orders') {
    return showOrderHistory(phone, env);
  }

  // MENU / START / HI / HELLO / cmd_menu
  session.state = 'idle';
  await saveSession(phone, session, env);
  return showWelcome(phone, env);
}

// ─────────────────────────────────────────────────────────────
// State handlers
// ─────────────────────────────────────────────────────────────

async function handleIdle(phone, msg, session, env) {
  return showWelcome(phone, env);
}

async function handleBrowsingMenu(phone, msg, session, env) {
  // BUG-16 FIX: removed dead `cmd_checkout` branch — no button with that ID exists
  if (msg.type === 'list_reply' && msg.id?.startsWith('cat_')) {
    const categoryId = parseInt(msg.id.replace('cat_', ''), 10);
    return showItemsForCategory(phone, categoryId, msg.title, session, env);
  }
  return showMenuCategories(phone, session, env);
}

async function handleSelectingItem(phone, msg, session, env) {
  if (msg.type === 'list_reply' && msg.id?.startsWith('item_')) {
    const itemId = parseInt(msg.id.replace('item_', ''), 10);
    return showItemDetail(phone, itemId, session, env);
  }
  return showMenuCategories(phone, session, env);
}

async function handleItemDetail(phone, msg, session, env) {
  if (msg.id === 'btn_add') {
    session.state = 'entering_quantity';
    await saveSession(phone, session, env);
    return sendText(phone, '🔢 How many would you like? (1–20)', env);
  }
  if (msg.id === 'btn_back_menu') {
    session.tempItemId = null;
    await saveSession(phone, session, env);
    return showMenuCategories(phone, session, env);
  }
  if (msg.id === 'btn_checkout') {
    return showCart(phone, session, env);
  }
  // Any other input while on item detail — re-render the item
  return showItemDetail(phone, session.tempItemId, session, env);
}

async function handleEnteringQuantity(phone, msg, session, env) {
  const raw = (msg.text || '').trim();
  // BUG-12 style: strict integer check — "5abc" must not pass as 5
  const qty = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;

  if (isNaN(qty) || qty < 1 || qty > 20) {
    return sendText(phone, '⚠️ Please enter a whole number between 1 and 20.', env);
  }

  session.tempQty = qty;
  session.state   = 'entering_notes';
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `📝 Any special notes for this item?\n(e.g. "No onions", "Extra sauce")`,
    [{ id: 'notes_none', title: 'No notes' }],
    env
  );
}

async function handleEnteringNotes(phone, msg, session, env) {
  const notes = msg.id === 'notes_none' ? '' : sanitize(msg.text || '', 200);

  if (!session.tempItemId || !session.tempQty) {
    session.state = 'idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ Something went wrong. Please start over.', env);
  }

  const item = await getMenuItem(session.tempItemId, env);
  if (!item) {
    session.state = 'idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ That item is no longer available. Please try again.', env);
  }

  addToCart(session.cart, {
    itemId:    item.id,
    name:      item.name,
    qty:       session.tempQty,
    unitPrice: item.price,
    notes,
  });

  session.state      = 'cart_review';
  session.tempItemId = null;
  session.tempQty    = null;
  await saveSession(phone, session, env);

  return showCart(phone, session, env);
}

async function handleCartReview(phone, msg, session, env) {
  if (msg.id === 'btn_checkout_start') {
    if (!session.cart.length) {
      return sendText(phone, '🛒 Your cart is empty. Browse the menu first.', env);
    }
    session.state = 'checkout_address';
    await saveSession(phone, session, env);
    return sendText(
      phone,
      '📍 Please enter your *delivery address*:\n\n_(Type your full address and press send)_',
      env
    );
  }
  if (msg.id === 'btn_keep_shopping') return showMenuCategories(phone, session, env);
  if (msg.id === 'btn_clear_cart') {
    clearCart(session);
    session.state = 'idle';
    await saveSession(phone, session, env);
    return sendText(phone, '🗑️ Cart cleared!', env);
  }
  return showCart(phone, session, env);
}

async function handleCheckoutAddress(phone, msg, session, env) {
  const address = sanitize(msg.text || '', 300);
  if (address.length < 5) {
    return sendText(phone, '⚠️ Please enter a valid delivery address (at least 5 characters).', env);
  }

  session.tempAddress = address;
  session.state = 'checkout_confirm';
  await saveSession(phone, session, env);

  // BUG-08 FIX: Checkout confirm body can exceed 1024 chars with many items.
  // We build the summary first and truncate intelligently if needed.
  const total   = cartTotal(session.cart).toFixed(2);
  let   summary = cartSummary(session.cart);

  // Budget: prefix + summary + address + suffix
  const prefix  = `🧾 *Order Summary*\n\n`;
  const suffix  = `\n\n📍 *Address:* ${address}\n\n💳 *Total: $${total}*\n\nReady to place your order?`;
  const budget  = CONFIRM_BODY_MAX - prefix.length - suffix.length;

  if (summary.length > budget) {
    const count  = session.cart.length;
    const ttl    = cartTotal(session.cart).toFixed(2);
    summary = `${count} item${count !== 1 ? 's' : ''} in your order.\n\n*Total: $${ttl}*`;
  }

  return sendButtons(
    phone,
    `${prefix}${summary}${suffix}`,
    [
      { id: 'btn_place_order', title: '✅ Place Order' },
      { id: 'btn_edit_cart',   title: '✏️ Edit Order'  },
    ],
    env,
    'Confirm Your Order'
  );
}

async function handleCheckoutConfirm(phone, msg, session, env) {
  if (msg.id === 'btn_edit_cart') {
    session.state = 'cart_review';
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }

  if (msg.id === 'btn_place_order') {
    try {
      const orderId = await createOrder(
        {
          userPhone:  phone,
          totalPrice: cartTotal(session.cart),
          address:    session.tempAddress || '',
          items:      session.cart,
        },
        env
      );

      clearCart(session);
      session.state = 'idle';
      delete session.tempAddress;
      await saveSession(phone, session, env);

      return sendButtons(
        phone,
        `🎉 *Order #${orderId} placed!*\n\nWe've received your order and will start preparing it shortly.\n\nYou'll receive updates here. Track anytime with *ORDERS*.`,
        [{ id: 'cmd_menu', title: '🍔 Order Again' }],
        env,
        'Order Confirmed!'
      );
    } catch (err) {
      console.error('[Checkout] createOrder failed:', err);
      // Session unchanged — user stays in checkout_confirm and can retry
      return sendButtons(
        phone,
        `⚠️ We couldn't place your order due to a system error. Please try again.`,
        [
          { id: 'btn_place_order', title: '🔄 Retry'        },
          { id: 'cmd_cancel',      title: '❌ Cancel Order'  },
        ],
        env
      );
    }
  }

  return showCart(phone, session, env);
}

// ─────────────────────────────────────────────────────────────
// View helpers
// ─────────────────────────────────────────────────────────────

async function showWelcome(phone, env) {
  return sendButtons(
    phone,
    `👋 Welcome to *FoodBot*! 🍔🍕🥤\n\nOrder fresh food delivered to your door.\n\nWhat would you like to do?`,
    [
      { id: 'cmd_menu',   title: '🍽️ View Menu'  },
      { id: 'cmd_cart',   title: '🛒 My Cart'     },
      { id: 'cmd_orders', title: '📋 My Orders'   },
    ],
    env,
    '🍔 FoodBot',
    'Fast. Fresh. Delivered.'
  );
}

async function showMenuCategories(phone, session, env) {
  const menu = await getMenuCached(env);

  // BUG-07 FIX: empty category list would cause the WhatsApp API to reject
  // the list message (requires ≥1 row). Graceful fallback instead of crash.
  if (!menu.categories.length) {
    return sendText(phone, '📭 Our menu is being set up. Check back soon!', env);
  }

  const rows = menu.categories.map(cat => ({
    id:          `cat_${cat.id}`,
    title:       cat.name,
    description: `${(menu.itemsByCategory[cat.id] || []).length} items`,
  }));

  session.state = 'browsing_menu';
  await saveSession(phone, session, env);

  return sendList(
    phone,
    '🗂️ Choose a *category* to browse:',
    'Browse Menu',
    [{ title: 'Menu Categories', rows }],
    env
  );
}

async function showItemsForCategory(phone, categoryId, categoryName, session, env) {
  const menu  = await getMenuCached(env);
  const items = menu.itemsByCategory[categoryId] || [];

  if (!items.length) {
    return sendText(phone, `😕 No items available in ${categoryName} right now.`, env);
  }

  const rows = items.map(item => ({
    id:          `item_${item.id}`,
    title:       item.name,
    description: `$${item.price.toFixed(2)} — ${(item.description || '').slice(0, 60)}`,
  }));

  session.state = 'selecting_item';
  await saveSession(phone, session, env);

  return sendList(
    phone,
    `🍽️ *${categoryName}*\n\nSelect an item to see details:`,
    'Choose Item',
    [{ title: categoryName, rows }],
    env
  );
}

async function showItemDetail(phone, itemId, session, env) {
  const item = await getMenuItem(itemId, env);
  if (!item) {
    return sendText(phone, '⚠️ Item not found.', env);
  }

  session.tempItemId = item.id;
  session.state      = 'item_detail';
  await saveSession(phone, session, env);

  const hasCartItems = session.cart.length > 0;
  const buttons = [{ id: 'btn_add', title: '➕ Add to Cart' }];
  if (hasCartItems) buttons.push({ id: 'btn_checkout', title: '🛒 View Cart' });
  buttons.push({ id: 'btn_back_menu', title: '⬅️ Back to Menu' });

  const bodyText = `*${item.name}*\n💰 $${item.price.toFixed(2)}\n\n${item.description || 'No description.'}`;

  // BUG-28 FIX: Use imageButtonPayload to send image + buttons as ONE message
  // instead of two separate API calls (sendImage then sendButtons).
  if (item.image_url) {
    return sendImageButtons(phone, bodyText, buttons, item.image_url, env);
  }

  return sendButtons(phone, bodyText, buttons, env, item.name);
}

async function showCart(phone, session, env) {
  // BUG-29 FIX: Skip the KV write if we're already in cart_review state.
  if (session.state !== 'cart_review') {
    session.state = 'cart_review';
    await saveSession(phone, session, env);
  }

  if (!session.cart.length) {
    return sendButtons(
      phone,
      '🛒 Your cart is empty.\nBrowse our menu to add items!',
      [{ id: 'cmd_menu', title: '🍽️ Browse Menu' }],
      env
    );
  }

  const summary = cartSummary(session.cart);
  return sendButtons(
    phone,
    `🛒 *Your Cart*\n\n${summary}`,
    [
      { id: 'btn_checkout_start', title: '✅ Checkout'     },
      { id: 'btn_keep_shopping',  title: '➕ Add More'     },
      { id: 'btn_clear_cart',     title: '🗑️ Clear Cart'  },
    ],
    env,
    'Shopping Cart'
  );
}

async function showOrderHistory(phone, env) {
  const orders = await getUserOrders(phone, env);
  if (!orders.length) {
    return sendText(phone, '📋 You have no previous orders yet.', env);
  }

  const statusEmoji = {
    pending:   '⏳', confirmed: '✅', preparing: '👨‍🍳',
    ready:     '📦', delivered: '🎉', cancelled:  '❌',
  };

  const lines = orders.map(
    o =>
      `• Order #${o.id}  ${statusEmoji[o.status] || '•'} ${o.status.toUpperCase()}\n` +
      `  $${Number(o.total_price).toFixed(2)} — ${o.created_at.slice(0, 10)}`
  );

  return sendText(phone, `📋 *Your Recent Orders*\n\n${lines.join('\n\n')}`, env);
}

// ─────────────────────────────────────────────────────────────
// Menu loader with KV cache
// ─────────────────────────────────────────────────────────────

async function getMenuCached(env) {
  const cached = await getCachedMenu(env);  // BUG-01 FIX: from session.js
  if (cached) return cached;
  const menu = await getFullMenu(env);
  await cacheMenu(menu, env);               // BUG-01 FIX: from session.js
  return menu;
}
