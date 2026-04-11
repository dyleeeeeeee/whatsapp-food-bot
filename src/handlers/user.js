/**
 * src/handlers/user.js — Customer Conversation State Machine
 *
 * States:
 *   idle                → welcome screen
 *   browsing_menu       → category list
 *   selecting_item      → item list for a category
 *   item_detail         → item detail + add-to-cart
 *   entering_quantity   → "How many?"
 *   entering_notes      → "Any notes?"
 *   cart_review         → cart summary
 *   checkout_address    → "Enter your delivery address"
 *   checkout_confirm    → order confirmation
 */

import {
  sendText, sendButtons, sendList, sendImage
} from '../whatsapp.js';
import {
  getSession, saveSession, clearSession,
  addToCart, cartSummary, cartTotal, clearCart,
} from '../session.js';
import {
  getFullMenu, getMenuItem, getCachedMenu as _getCachedMenu,
  cacheMenu, createOrder, getUserOrders,
} from '../db.js';
import { sanitize } from '../security.js';

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export async function handleUserMessage(phone, msg, env) {
  const session = await getSession(phone, env);
  const { state } = session;

  // Global shortcuts available in any state
  if (isGlobalCommand(msg)) {
    return handleGlobalCommand(phone, msg, session, env);
  }

  switch (state) {
    case 'idle':
      return handleIdle(phone, msg, session, env);
    case 'browsing_menu':
      return handleBrowsingMenu(phone, msg, session, env);
    case 'selecting_item':
      return handleSelectingItem(phone, msg, session, env);
    case 'item_detail':
      return handleItemDetail(phone, msg, session, env);
    case 'entering_quantity':
      return handleEnteringQuantity(phone, msg, session, env);
    case 'entering_notes':
      return handleEnteringNotes(phone, msg, session, env);
    case 'cart_review':
      return handleCartReview(phone, msg, session, env);
    case 'checkout_address':
      return handleCheckoutAddress(phone, msg, session, env);
    case 'checkout_confirm':
      return handleCheckoutConfirm(phone, msg, session, env);
    default:
      return handleIdle(phone, msg, session, env);
  }
}

// ─────────────────────────────────────────────────────────────
// Global commands
// ─────────────────────────────────────────────────────────────

function isGlobalCommand(msg) {
  const t = (msg.text || msg.id || '').toUpperCase();
  return (
    t === 'MENU' || t === 'START' || t === 'HI' || t === 'HELLO' ||
    t === 'CART' || t === 'ORDERS' || t === 'CANCEL' ||
    msg.id === 'cmd_menu' || msg.id === 'cmd_cart' || msg.id === 'cmd_cancel'
  );
}

async function handleGlobalCommand(phone, msg, session, env) {
  const t = (msg.text || msg.id || '').toUpperCase();

  if (t === 'CANCEL' || msg.id === 'cmd_cancel') {
    clearCart(session);
    session.state = 'idle';
    await saveSession(phone, session, env);
    return sendText(phone, '🚫 Order cancelled. Send *MENU* to start again.', env);
  }

  if (t === 'CART' || msg.id === 'cmd_cart') {
    return showCart(phone, session, env);
  }

  if (t === 'ORDERS') {
    return showOrderHistory(phone, env);
  }

  // Default: show welcome
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
  // Expecting a list_reply with category_id
  if (msg.type === 'list_reply' && msg.id?.startsWith('cat_')) {
    const categoryId = parseInt(msg.id.replace('cat_', ''), 10);
    return showItemsForCategory(phone, categoryId, msg.title, session, env);
  }
  if (msg.id === 'cmd_checkout') return showCart(phone, session, env);
  return showMenuCategories(phone, session, env);
}

async function handleSelectingItem(phone, msg, session, env) {
  if (msg.type === 'list_reply' && msg.id?.startsWith('item_')) {
    const itemId = parseInt(msg.id.replace('item_', ''), 10);
    return showItemDetail(phone, itemId, session, env);
  }
  if (msg.id === 'cmd_menu') return showMenuCategories(phone, session, env);
  return showMenuCategories(phone, session, env);
}

async function handleItemDetail(phone, msg, session, env) {
  if (msg.id === 'btn_add') {
    session.state = 'entering_quantity';
    await saveSession(phone, session, env);
    return sendText(phone, '🔢 How many would you like? (Enter a number, max 20)', env);
  }
  if (msg.id === 'btn_back_menu') return showMenuCategories(phone, session, env);
  if (msg.id === 'btn_checkout') return showCart(phone, session, env);
  return showItemDetail(phone, session.tempItemId, session, env);
}

async function handleEnteringQuantity(phone, msg, session, env) {
  const qty = parseInt(msg.text || '', 10);
  if (isNaN(qty) || qty < 1 || qty > 20) {
    return sendText(phone, '⚠️ Please enter a number between 1 and 20.', env);
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
  const notes =
    msg.id === 'notes_none' ? '' : sanitize(msg.text || '', 200);

  const item = await getMenuItem(session.tempItemId, env);
  if (!item) {
    session.state = 'idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ Item not found. Please try again.', env);
  }

  addToCart(session.cart, {
    itemId:    item.id,
    name:      item.name,
    qty:       session.tempQty,
    unitPrice: item.price,
    notes,
  });

  session.state    = 'cart_review';
  session.tempItemId = null;
  session.tempQty  = null;
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

  const summary = cartSummary(session.cart);
  const total   = cartTotal(session.cart).toFixed(2);

  return sendButtons(
    phone,
    `🧾 *Order Summary*\n\n${summary}\n\n📍 *Address:* ${address}\n\n💳 *Total: $${total}*\n\nReady to place your order?`,
    [
      { id: 'btn_place_order', title: '✅ Place Order'  },
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
      `🎉 *Order #${orderId} placed!*\n\nWe've received your order and will start preparing it shortly.\n\nYou'll receive status updates here. Track with *ORDERS*.`,
      [{ id: 'cmd_menu', title: '🍔 Order Again' }],
      env,
      'Order Confirmed!'
    );
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
      { id: 'cmd_menu',   title: '🍽️ View Menu'    },
      { id: 'cmd_cart',   title: '🛒 My Cart'       },
      { id: 'cmd_orders', title: '📋 My Orders'     },
    ],
    env,
    '🍔 FoodBot',
    'Fast. Fresh. Delivered.'
  );
}

async function showMenuCategories(phone, session, env) {
  const menu = await getMenu(env);

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
  const menu  = await getMenu(env);
  const items = menu.itemsByCategory[categoryId] || [];

  if (!items.length) {
    return sendText(phone, `😕 No items available in ${categoryName} right now.`, env);
  }

  const rows = items.map(item => ({
    id:          `item_${item.id}`,
    title:       item.name,
    description: `$${item.price.toFixed(2)} — ${item.description.slice(0, 60)}`,
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

  // Send image first if available
  if (item.image_url) {
    await sendImage(phone, item.image_url, item.name, env).catch(() => {});
  }

  const hasItems = session.cart.length > 0;
  const buttons  = [{ id: 'btn_add', title: '➕ Add to Cart' }];
  if (hasItems) buttons.push({ id: 'btn_checkout', title: '🛒 View Cart' });
  buttons.push({ id: 'btn_back_menu', title: '⬅️ Back to Menu' });

  return sendButtons(
    phone,
    `*${item.name}*\n💰 $${item.price.toFixed(2)}\n\n${item.description || 'No description.'}`,
    buttons.slice(0, 3),
    env,
    item.name
  );
}

async function showCart(phone, session, env) {
  session.state = 'cart_review';
  await saveSession(phone, session, env);

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
      { id: 'btn_checkout_start', title: '✅ Checkout'      },
      { id: 'btn_keep_shopping',  title: '➕ Add More'      },
      { id: 'btn_clear_cart',     title: '🗑️ Clear Cart'   },
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
    pending:    '⏳', confirmed: '✅', preparing: '👨‍🍳',
    ready:      '📦', delivered: '🎉', cancelled: '❌',
  };

  const lines = orders.map(
    o =>
      `• Order #${o.id}  ${statusEmoji[o.status] || '•'} ${o.status.toUpperCase()}\n  $${Number(o.total_price).toFixed(2)} — ${o.created_at.slice(0, 10)}`
  );

  return sendText(phone, `📋 *Your Recent Orders*\n\n${lines.join('\n\n')}`, env);
}

// ─────────────────────────────────────────────────────────────
// Menu loader (KV-cached)
// ─────────────────────────────────────────────────────────────

async function getMenu(env) {
  const cached = await _getCachedMenu(env);
  if (cached) return cached;

  const menu = await getFullMenu(env);
  await cacheMenu(menu, env);
  return menu;
}

// Re-export for use in admin handler
export { showWelcome };
