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
  formatPrice,
} from '../session.js';
import {
  getFullMenu, getMenuItem, createOrder, getUserOrders, getOrder,
  updateOrderPayment,
} from '../db.js';
import { initializePaystackTransaction } from '../paystack.js';
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
    case 'cart_manage':      return handleCartManage(phone, msg, session, env);
    case 'cart_item_edit':   return handleCartItemEdit(phone, msg, session, env);
    case 'checkout_address':         return handleCheckoutAddress(phone, msg, session, env);
    case 'checkout_delivery_notes':  return handleCheckoutDeliveryNotes(phone, msg, session, env);
    case 'checkout_confirm':         return handleCheckoutConfirm(phone, msg, session, env);
    case 'order_tracking':           return handleOrderTracking(phone, msg, session, env);
    case 'confirm_cancel':           return handleConfirmCancel(phone, msg, session, env);
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
    t === 'CART'   || t === 'ORDERS' || t === 'CANCEL' || t === 'HELP' ||
    msg.id === 'cmd_menu'   || msg.id === 'cmd_cart' ||
    msg.id === 'cmd_cancel' || msg.id === 'cmd_orders' ||
    msg.id === 'cmd_help'
  );
}

async function handleGlobalCommand(phone, msg, session, env) {
  const t  = (msg.text || '').toUpperCase().trim();
  const id = msg.id || '';

  if (t === 'CANCEL' || id === 'cmd_cancel') {
    if (session.cart.length > 0 && session.state !== 'idle') {
      session.state = 'confirm_cancel';
      await saveSession(phone, session, env);
      return sendButtons(
        phone,
        '❓ *Are you sure you want to cancel your current order?*\n\nThis will clear your cart.',
        [
          { id: 'confirm_cancel_yes', title: 'Yes, Cancel' },
          { id: 'confirm_cancel_no',  title: 'No, Keep it' },
        ],
        env
      );
    }
    clearCart(session);
    session.state = 'idle';
    await saveSession(phone, session, env);
    return sendText(phone, '🚫 Order cancelled. Send *MENU* to start again.', env);
  }

  if (t === 'CART' || id === 'cmd_cart') {
    return showCart(phone, session, env);
  }

  if (t === 'ORDERS' || id === 'cmd_orders') {
    return showOrderHistory(phone, session, env);
  }

  if (t === 'HELP' || id === 'cmd_help') {
    return sendText(
      phone,
      '🆘 *FastChow Help*\n\n' +
      'I can help you order delicious food in just a few taps!\n\n' +
      '*Commands:*\n' +
      '• *MENU* — Browse our categories and items\n' +
      '• *CART* — Review items you have added\n' +
      '• *ORDERS* — Track your active and past orders\n' +
      '• *CANCEL* — Stop your current ordering process\n' +
      '• *HELP* — Show this guide again\n\n' +
      '💡 *Tip:* You can also type "BACK" during checkout to change your address or notes.\n\n' +
      'Still stuck? Just reply with your question and our team will assist you!',
      env
    );
  }

  if (t === 'MENU' || id === 'cmd_menu') {
    return showMenuCategories(phone, session, env);
  }

  // START / HI / HELLO (welcome greeting)
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
  // Any other input while on item detail — explain what to do
  return sendText(
    phone,
    '👆 Please tap a button above: *Add to Cart*, *View Cart*, or *Back to Menu*.\n\n' +
    'Or send *MENU* to start over or *HELP* for assistance.',
    env
  );
}

async function handleEnteringQuantity(phone, msg, session, env) {
  const raw = (msg.text || '').trim();
  // BUG-12 style: strict integer check — "5abc" must not pass as 5
  const qty = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;

  if (isNaN(qty) || qty < 1 || qty > 20) {
    return sendText(
      phone,
      '⚠️ Please enter a whole number between 1 and 20.\n\n' +
      'Examples: *1*, *3*, or *10*\n\n' +
      'Send *CANCEL* to go back.',
      env
    );
  }

  session.tempQty = qty;

  if (session.cartQtyEdit) {
    const idx = session.tempCartIdx;
    if (idx !== undefined && session.cart[idx]) {
      session.cart[idx].qty = qty;
      session.state = 'cart_review';
      delete session.tempCartIdx;
      delete session.cartQtyEdit;
      await saveSession(phone, session, env);
      return sendText(phone, `✅ Updated *${session.cart[idx].name}* quantity to ${qty}.`, env)
        .then(() => showCart(phone, session, env));
    }
  }

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

  // If we were editing quantity, we shouldn't even reach here, but guard just in case
  if (session.cartQtyEdit) {
    delete session.cartQtyEdit;
    session.state = 'cart_review';
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }

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
  
  if (msg.id === 'btn_manage_cart') {
    if (!session.cart.length) return showCart(phone, session, env);
    session.state = 'cart_manage';
    await saveSession(phone, session, env);
    
    const rows = session.cart.map((item, idx) => ({
      id: `cart_idx_${idx}`,
      title: `${item.name} (x${item.qty})`,
      description: `Notes: ${item.notes || 'None'}`
    }));
    rows.push({
      id: 'cart_clear_all',
      title: '🧹 Clear Entire Cart',
      description: 'Remove all items from cart'
    });

    return sendList(
      phone,
      '✏️ *Manage Cart*\nSelect an item to change or remove:',
      'Manage Items',
      [{ title: 'Your Items', rows }],
      env
    );
  }

  if (msg.id === 'btn_clear_cart') {
    session.state = 'confirm_cancel'; // Reuse confirm_cancel for clearing cart
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '❓ *Clear your entire cart?*',
      [
        { id: 'confirm_cancel_yes', title: 'Yes, Clear' },
        { id: 'confirm_cancel_no',  title: 'No, Keep it' },
      ],
      env
    );
  }
  return showCart(phone, session, env);
}

async function handleCartManage(phone, msg, session, env) {
  if (msg.type === 'list_reply' && msg.id === 'cart_clear_all') {
    session.state = 'confirm_cancel';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '❓ *Clear your entire cart?*',
      [
        { id: 'confirm_cancel_yes', title: 'Yes, Clear' },
        { id: 'confirm_cancel_no',  title: 'No, Keep it' },
      ],
      env
    );
  }

  if (msg.type === 'list_reply' && msg.id?.startsWith('cart_idx_')) {
    const idx = parseInt(msg.id.replace('cart_idx_', ''), 10);
    const item = session.cart[idx];
    if (!item) return showCart(phone, session, env);

    session.tempCartIdx = idx;
    session.state = 'cart_item_edit';
    await saveSession(phone, session, env);

    return sendButtons(
      phone,
      `✏️ *Managing: ${item.name}*\nQuantity: ${item.qty}\nNotes: ${item.notes || 'None'}`,
      [
        { id: 'cart_item_remove', title: '🗑️ Remove' },
        { id: 'cart_item_qty',    title: '🔢 Change Qty' },
        { id: 'btn_cart_back',    title: '⬅️ Back' }
      ],
      env
    );
  }
  
  return showCart(phone, session, env);
}

async function handleCartItemEdit(phone, msg, session, env) {
  const idx = session.tempCartIdx;
  if (idx === undefined || !session.cart[idx]) {
    session.state = 'cart_review';
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }

  if (msg.id === 'cart_item_remove') {
    const removed = session.cart.splice(idx, 1)[0];
    session.state = 'cart_review';
    delete session.tempCartIdx;
    await saveSession(phone, session, env);
    return sendText(phone, `✅ Removed *${removed.name}* from cart.`, env)
      .then(() => showCart(phone, session, env));
  }

  if (msg.id === 'cart_item_qty') {
    session.state = 'entering_quantity'; // Reuse entering_quantity but need to handle return path
    session.tempItemId = session.cart[idx].itemId; // Hack: setting this so handler thinks we're adding
    // Actually better to have a dedicated state or a flag in session
    session.cartQtyEdit = true; 
    await saveSession(phone, session, env);
    return sendText(phone, `🔢 Enter new quantity for *${session.cart[idx].name}* (1-20):`, env);
  }

  if (msg.id === 'btn_cart_back' || (msg.text || '').toUpperCase() === 'BACK') {
    session.state = 'cart_review';
    delete session.tempCartIdx;
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }

  return showCart(phone, session, env);
}

async function handleCheckoutAddress(phone, msg, session, env) {
  const address = sanitize(msg.text || '', 300);
  if (address.length < 5) {
    return sendText(
      phone,
      '⚠️ Please enter a valid delivery address (at least 5 characters).\n\n' +
      'Include your street, building number, and apartment if applicable.\n' +
      'Example: *123 Main St, Apt 4B*\n\n' +
      'Send *CANCEL* to go back.',
      env
    );
  }

  session.tempAddress = address;
  session.state = 'checkout_delivery_notes';
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    '📝 Any *delivery instructions*?\n\n' +
    'Examples: "Leave at door", "Ring doorbell", "Call on arrival"\n\n' +
    'Or tap *Skip* to continue.',
    [{ id: 'delivery_notes_skip', title: 'Skip' }],
    env
  );
}

async function handleCheckoutDeliveryNotes(phone, msg, session, env) {
  const t = (msg.text || '').toUpperCase().trim();
  if (t === 'BACK') {
    session.state = 'checkout_address';
    await saveSession(phone, session, env);
    return sendText(
      phone,
      '📍 Please enter your *delivery address*:\n\n_(Type your full address and press send)_',
      env
    );
  }

  const notes = msg.id === 'delivery_notes_skip'
    ? ''
    : sanitize(msg.text || '', 200);

  session.tempOrderNotes = notes;
  session.state = 'checkout_confirm';
  await saveSession(phone, session, env);

  const address = session.tempAddress || '';
  const orderNotes = session.tempOrderNotes || '';

  // BUG-08 FIX: Checkout confirm body can exceed 1024 chars with many items.
  // We build the summary first and truncate intelligently if needed.
  const total   = cartTotal(session.cart).toFixed(2);
  let   summary = cartSummary(session.cart);

  // Budget: prefix + summary + address + notes + suffix
  const prefix  = `🧾 *Order Summary*\n\n`;
  let middle    = `\n\n📍 *Address:* ${address}`;
  if (orderNotes) middle += `\n📝 *Instructions:* ${orderNotes}`;
  const suffix  = `\n\n💳 *Total: ₦${total}*\n\nReady to place your order?`;
  const budget  = CONFIRM_BODY_MAX - prefix.length - middle.length - suffix.length;

  if (summary.length > budget) {
    const count  = session.cart.length;
    const ttl    = cartTotal(session.cart).toFixed(2);
    summary = `${count} item${count !== 1 ? 's' : ''} in your order.\n\n*Total: ₦${ttl}*`;
  }

  return sendButtons(
    phone,
    `${prefix}${summary}${middle}${suffix}`,
    [
      { id: 'btn_place_order', title: '✅ Place Order' },
      { id: 'btn_edit_cart',   title: '✏️ Edit Order'  },
    ],
    env,
    'Confirm Your Order'
  );
}

async function handleCheckoutConfirm(phone, msg, session, env) {
  const t = (msg.text || '').toUpperCase().trim();
  if (t === 'BACK') {
    session.state = 'checkout_delivery_notes';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '📝 Any *delivery instructions*?\n\n' +
      'Examples: "Leave at door", "Ring doorbell", "Call on arrival"\n\n' +
      'Or tap *Skip* to continue.',
      [{ id: 'delivery_notes_skip', title: 'Skip' }],
      env
    );
  }

  if (msg.id === 'btn_edit_cart') {
    session.state = 'cart_review';
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }

  if (msg.id === 'btn_place_order') {
    try {
      // 1. Create order in D1
      const orderId = await createOrder(
        {
          userPhone:  phone,
          address:    session.tempAddress || '',
          orderNotes: session.tempOrderNotes || '',
          items:      session.cart,
          paymentStatus: 'unpaid',
        },
        env
      );

      // 2. Initialize Paystack
      const amountKobo = Math.round(cartTotal(session.cart) * 100);
      const reference = `order_${orderId}_${Date.now()}`;
      
      let payData;
      try {
        payData = await initializePaystackTransaction({
          amountKobo,
          reference,
          metadata: { orderId, phone }
        }, env);

        // 3. Update order with Paystack details
        await updateOrderPayment(orderId, {
          payment_reference: reference,
          payment_url: payData.authorization_url,
          payment_access_code: payData.access_code,
          payment_status: 'pending'
        }, env);
      } catch (payErr) {
        console.error('[Checkout] Paystack init failed:', payErr);
        // We still created the order, but payment link failed.
        // We'll let the user know and they can retry from My Orders.
      }

      clearCart(session);
      session.state = 'idle';
      delete session.tempAddress;
      delete session.tempOrderNotes;
      await saveSession(phone, session, env);

      if (payData) {
        return sendText(
          phone,
          `🎉 *Order #${orderId} placed!*\n\n` +
          `💰 Total: ${formatPrice(amountKobo / 100)}\n\n` +
          `💳 *Action Required:* Please complete your payment to confirm this order:\n\n` +
          `${payData.authorization_url}\n\n` +
          `Once paid, we will begin preparing your meal! Track anytime with *ORDERS*.`,
          env
        );
      } else {
        return sendButtons(
          phone,
          `🎉 *Order #${orderId} placed!*\n\n` +
          `⚠️ We had trouble creating your payment link. You can try paying again from *My Orders*.`,
          [{ id: 'cmd_orders', title: '📋 My Orders' }],
          env
        );
      }
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

async function handleConfirmCancel(phone, msg, session, env) {
  if (msg.id === 'confirm_cancel_yes') {
    clearCart(session);
    session.state = 'idle';
    await saveSession(phone, session, env);
    return sendText(phone, '🚫 Order cancelled. Send *MENU* to start again.', env);
  }

  // No or any other input — return to where they were
  session.state = 'cart_review'; // Fallback to cart review if we lost exact state
  await saveSession(phone, session, env);
  return showCart(phone, session, env);
}

// ─────────────────────────────────────────────────────────────
// View helpers
// ─────────────────────────────────────────────────────────────

async function showWelcome(phone, env) {
  return sendButtons(
    phone,
    `👋 Welcome to *FastChow*! 🍔🍕🥤\n\nOrder fresh food delivered to your door.\n\nWhat would you like to do?\n\nNeed help? Send *HELP* anytime.`,
    [
      { id: 'cmd_menu',   title: '🍽️ View Menu'  },
      { id: 'cmd_cart',   title: '🛒 My Cart'     },
      { id: 'cmd_orders', title: '📋 My Orders'   },
    ],
    env,
    '🍔 FastChow',
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

  const rows = items.map(item => {
    const priceStr = `₦${item.price.toFixed(2)}`;
    // Ensure price is visible: max 72 chars for description, budget for price
    const maxDesc = 72 - priceStr.length - 3; // " — " separator
    const desc = (item.description || '').slice(0, Math.max(0, maxDesc));
    return {
      id:          `item_${item.id}`,
      title:       item.name.slice(0, 24), // Title max 24 chars per WhatsApp limits
      description: `${priceStr} — ${desc || 'Tap to order'}`,
    };
  });

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

  const bodyText = `*${item.name}*\n💰 ₦${item.price.toFixed(2)}\n\n${item.description || 'No description.'}`;

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
      { id: 'btn_manage_cart',    title: '✏️ Manage'       },
    ],
    env,
    'Shopping Cart'
  );
}

async function showOrderHistory(phone, session, env) {
  session.state = 'order_tracking';
  await saveSession(phone, session, env);

  const orders = await getUserOrders(phone, env);
  if (!orders.length) {
    return sendText(phone, '📋 You have no previous orders yet.', env);
  }

  const statusEmoji = {
    pending:   '⏳', confirmed: '✅', preparing: '👨‍🍳',
    ready:     '📦', delivered: '🎉', cancelled:  '❌',
  };

  const rows = orders.map(o => ({
    id: `track_${o.id}`,
    title: `Order #${o.id} - ${o.status.toUpperCase()}`,
    description: `${formatPrice(o.total_price)} — ${o.created_at.slice(0, 10)}`
  }));

  return sendList(
    phone,
    '📋 *Your Recent Orders*\nSelect an order to see details and track its status:',
    'View Orders',
    [{ title: 'Order History', rows }],
    env
  );
}

async function handleOrderTracking(phone, msg, session, env) {
  if (msg.type === 'list_reply' && msg.id?.startsWith('track_')) {
    const orderId = parseInt(msg.id.replace('track_', ''), 10);
    const order = await getOrder(orderId, env);
    if (!order) return showOrderHistory(phone, session, env);

    const statusEmoji = {
      pending:   '⏳ Pending',
      confirmed: '✅ Confirmed',
      preparing: '👨‍🍳 Preparing',
      ready:     '📦 Ready for Pickup/Delivery',
      delivered: '🎉 Delivered',
      cancelled: '❌ Cancelled',
    };

    const statusDesc = {
      pending:   'We have received your order and are waiting for confirmation.',
      confirmed: 'Your order has been confirmed and will be prepared soon.',
      preparing: 'Our chefs are busy preparing your delicious meal!',
      ready:     'Your order is ready! It will be with you shortly.',
      delivered: 'Enjoy your meal! We hope you love it.',
      cancelled: 'This order was cancelled. Contact us if you have any questions.',
    };

    const itemsSummary = order.items.map(i => `• ${i.name} x${i.quantity}`).join('\n');
    
    const paymentEmoji = {
      paid: '✅ Paid',
      pending: '⏳ Pending',
      unpaid: '❌ Unpaid',
      failed: '⚠️ Failed'
    };

    let body = 
      `📦 *Order #${order.id} Details*\n\n` +
      `*Status:* ${statusEmoji[order.status] || order.status}\n` +
      `_${statusDesc[order.status] || ''}_\n\n` +
      `*Payment:* ${paymentEmoji[order.payment_status] || order.payment_status}\n`;

    if (order.payment_status !== 'paid' && order.payment_url) {
      body += `🔗 *Pay here:* ${order.payment_url}\n`;
    }

    body += 
      `\n*Items:*\n${itemsSummary}\n\n` +
      `*Total:* ${formatPrice(order.total_price)}\n` +
      `*Address:* ${order.address}\n` +
      `*Notes:* ${order.notes || 'None'}\n\n` +
      `*Placed on:* ${order.created_at}`;

    return sendButtons(
      phone,
      body,
      [
        { id: 'cmd_orders', title: '⬅️ Back to History' },
        { id: 'cmd_menu',   title: '🍽️ View Menu'       },
      ],
      env
    );
  }

  return showOrderHistory(phone, session, env);
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
