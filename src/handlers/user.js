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
  getFullMenu, getMenuItem, getAvailableMenuItem, createOrder, getUserOrders, getOrder,
  updateOrderPayment,
} from '../db.js';
import { initializeFlutterwaveTransaction } from '../payments/flutterwave.js';
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

  // Correct stale KV state using button ID as ground truth
  const inferred = inferStateFromMessage(msg, session);
  if (inferred) session.state = inferred;

  console.log('[User] state:', session.state, '| msg.type:', msg.type, '| msg.id:', msg.id, '| msg.text:', msg.text?.slice(0, 30));

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

// Infer the correct state from the button ID when KV may be stale.
// Returns the inferred state string, or null to trust stored state.
function inferStateFromMessage(msg, session) {
  const id = msg.id || '';

  if (id.startsWith('qty_1_') || id.startsWith('qty_custom_')) return 'item_detail';
  if (id.startsWith('qty_') && /^qty_\d+$/.test(id)) return 'entering_quantity';
  if (id === 'btn_checkout_start' || id === 'btn_keep_shopping' || id === 'btn_manage_cart' || id === 'btn_clear_cart') return 'cart_review';
  if (id === 'btn_place_order' || id === 'btn_edit_cart') return 'checkout_confirm';
  if (id === 'delivery_notes_skip') return 'checkout_delivery_notes';
  if (id.startsWith('item_') && msg.type === 'list_reply') return 'selecting_item';
  if ((id.startsWith('page_next_') || id.startsWith('page_prev_')) && msg.type === 'list_reply') return 'selecting_item';
  if (id.startsWith('cat_') && msg.type === 'list_reply') return 'browsing_menu';
  if ((id.startsWith('cart_idx_') || id === 'cart_clear_all') && msg.type === 'list_reply') return 'cart_manage';
  if (id === 'cart_item_remove' || id === 'cart_item_qty' || id === 'cart_item_notes' || id === 'btn_cart_back') return 'cart_item_edit';
  if (id === 'confirm_cancel_yes' || id === 'confirm_cancel_no') return 'confirm_cancel';

  // KV stale-state recovery for checkout text input.
  // Button IDs are ground truth, but plain text during checkout has no ID.
  // If KV state hasn't propagated yet, we infer based on cart + tempAddress.
  // Exception: numeric text (1-20) while in item_detail/entering_quantity is a qty, not an address.
  const browsingStates = ['browsing_menu', 'selecting_item', 'cart_review'];
  const isNumericQty = msg.type === 'text' && /^\d+$/.test((msg.text || '').trim()) && parseInt(msg.text, 10) >= 1 && parseInt(msg.text, 10) <= 20;
  if (msg.type === 'text' && !id && session.cart && session.cart.length > 0 && !isNumericQty) {
    // tempAddress not yet set → user is typing their address
    if (!session.tempAddress && browsingStates.includes(session.state)) {
      return 'checkout_address';
    }
    // tempAddress already set → user is typing delivery instructions
    if (session.tempAddress && browsingStates.includes(session.state)) {
      return 'checkout_delivery_notes';
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Global commands — active in every state
// ─────────────────────────────────────────────────────────────

function isGlobalCommand(msg) {
  const t = (msg.text || '').toUpperCase().trim();
  return (
    t === 'MENU'   || t === 'START'  || t === 'HI' || t === 'HELLO' ||
    t === 'CART'   || t === 'ORDERS' || t === 'CANCEL' || t === 'HELP' ||
    t === 'EXIT'   || t === 'EXIT USER MODE' ||
    msg.id === 'cmd_menu'   || msg.id === 'cmd_cart' ||
    msg.id === 'cmd_cancel' || msg.id === 'cmd_orders' ||
    msg.id === 'cmd_help'    || msg.id === 'exit_user_mode'
  );
}

async function handleGlobalCommand(phone, msg, session, env) {
  const t  = (msg.text || '').toUpperCase().trim();
  const id = msg.id || '';

  if (t === 'EXIT' || t === 'EXIT USER MODE' || id === 'exit_user_mode') {
    if (session.adminUserMode) {
      session.adminUserMode = false;
      session.state = 'admin_idle';
      session.adminCtx = {};
      clearCart(session);
      await saveSession(phone, session, env);
      return sendText(phone, '🔧 *User Mode Exited*\n\nReturning to Admin Panel.', env)
        .then(() => import('../handlers/admin.js').then(m => m.handleAdminMessage(phone, { type: 'button_reply', id: 'admin_home' }, session, env)));
    }
    return sendText(phone, '⚠️ Not in User Mode. Send *HELP* for commands.', env);
  }

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

  // Pagination nav: page_next_{catId}_{page} or page_prev_{catId}_{page}
  if (msg.type === 'list_reply' && (msg.id?.startsWith('page_next_') || msg.id?.startsWith('page_prev_'))) {
    const parts = msg.id.split('_');
    // format: page_(next|prev)_{categoryId}_{page}
    const catId = parseInt(parts[2], 10);
    const page  = parseInt(parts[3], 10);
    const catName = session.tempCategoryName || msg.title || 'Menu';
    return showItemsForCategory(phone, catId, catName, session, env, page);
  }

  return showMenuCategories(phone, session, env);
}

async function handleItemDetail(phone, msg, session, env) {
  // Recover item ID from button ID if KV is stale (btn format: qty_1_{itemId})
  const id = msg.id || '';
  if (id.startsWith('qty_1_') || id.startsWith('qty_custom_')) {
    const parts = id.split('_');
    const embeddedId = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(embeddedId) && !session.tempItemId) {
      session.tempItemId = embeddedId;
    }
  }

  // Instant add: quantity 1
  if (id.startsWith('qty_1_')) {
    return addItemToCartAndConfirm(phone, session, 1, env);
  }

  // Custom quantity: show qty buttons + accept text
  if (id.startsWith('qty_custom_')) {
    session.state = 'entering_quantity';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '🔢 How many would you like?\n\nTap a button or type any number (1–20):',
      [
        { id: 'qty_2', title: '2' },
        { id: 'qty_3', title: '3' },
        { id: 'qty_5', title: '5' },
      ],
      env,
      null,
      'MENU | CART | CANCEL'
    );
  }

  if (msg.id === 'btn_back_menu') {
    session.tempItemId = null;
    await saveSession(phone, session, env);
    // Return to the category the user came from, not the top-level menu
    if (session.tempCategoryId) {
      return showItemsForCategory(
        phone, session.tempCategoryId, session.tempCategoryName || 'Menu', session, env
      );
    }
    return showMenuCategories(phone, session, env);
  }

  // Numeric text while on item_detail = treat as qty (handles KV race)
  const raw = (msg.text || '').trim();
  const qty = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  if (!isNaN(qty) && qty >= 1 && qty <= 20) {
    return addItemToCartAndConfirm(phone, session, qty, env);
  }

  return sendText(
    phone,
    '👆 Tap *Add 1* to add to cart, *Choose Qty* for a custom amount, or *Back* to return.\n\n' +
    'Or send *MENU* to browse, *CART* to view cart.',
    env
  );
}

async function handleEnteringQuantity(phone, msg, session, env) {
  // Button-based qty selection (qty_2, qty_3, qty_5, etc.)
  if (msg.id?.startsWith('qty_') && /^qty_\d+$/.test(msg.id)) {
    const qty = parseInt(msg.id.replace('qty_', ''), 10);
    if (qty >= 1 && qty <= 20) {
      if (session.cartQtyEdit) return updateCartQty(phone, session, qty, env);
      return addItemToCartAndConfirm(phone, session, qty, env);
    }
  }

  // Text-based qty
  const raw = (msg.text || '').trim();
  const qty = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;

  if (isNaN(qty) || qty < 1 || qty > 20) {
    return sendButtons(
      phone,
      '⚠️ Please enter a number between 1 and 20, or tap a button:',
      [
        { id: 'qty_2', title: '2' },
        { id: 'qty_3', title: '3' },
        { id: 'qty_5', title: '5' },
      ],
      env,
      null,
      'MENU | CART | CANCEL'
    );
  }

  if (session.cartQtyEdit) return updateCartQty(phone, session, qty, env);
  return addItemToCartAndConfirm(phone, session, qty, env);
}

async function updateCartQty(phone, session, qty, env) {
  const idx = session.tempCartIdx;
  if (idx !== undefined && session.cart[idx]) {
    const name = session.cart[idx].name;
    session.cart[idx].qty = qty;
    session.state = 'cart_review';
    delete session.tempCartIdx;
    delete session.cartQtyEdit;
    await saveSession(phone, session, env);
    return sendText(phone, `✅ Updated *${name}* quantity to ${qty}.`, env)
      .then(() => showCart(phone, session, env));
  }
  session.state = 'cart_review';
  await saveSession(phone, session, env);
  return showCart(phone, session, env);
}

async function handleEnteringNotes(phone, msg, session, env) {
  // This state is only reached from cart item editing (cart_item_notes button).
  const notes = msg.id === 'notes_none' ? '' : sanitize(msg.text || '', 200);

  const idx = session.tempCartIdx;
  if (idx !== undefined && session.cart[idx]) {
    const name = session.cart[idx].name;
    session.cart[idx].notes = notes;
    session.state = 'cart_review';
    delete session.tempCartIdx;
    delete session.cartQtyEdit;
    await saveSession(phone, session, env);
    return sendText(phone, `✅ Notes updated for *${name}*.`, env)
      .then(() => showCart(phone, session, env));
  }

  // Fallback: in-flight sessions from old flow — add item to cart with notes
  if (session.tempItemId && session.tempQty) {
    const item = await getAvailableMenuItem(session.tempItemId, env);
    if (item) {
      addToCart(session.cart, {
        itemId:    item.id,
        name:      item.name,
        qty:       session.tempQty,
        unitPrice: item.price,
        notes,
      });
    }
  }

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
      title: '🧹 Clear Cart',
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
    session.state = 'confirm_cancel';
    session.confirmCancelType = 'cart_clear';
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
    session.confirmCancelType = 'cart_clear';
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
        { id: 'cart_item_remove', title: '🗑️ Remove'      },
        { id: 'cart_item_qty',    title: '🔢 Change Qty'  },
        { id: 'cart_item_notes',  title: '📝 Edit Notes'  },
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

  // Handle global commands to escape stuck state
  const t = (msg.text || '').toUpperCase().trim();
  const id = msg.id || '';
  if (t === 'CANCEL' || id === 'cmd_cancel') {
    session.state = 'cart_review';
    delete session.tempCartIdx;
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }
  if (t === 'CART' || id === 'cmd_cart') {
    session.state = 'cart_review';
    delete session.tempCartIdx;
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }
  if (t === 'MENU' || id === 'cmd_menu') {
    session.state = 'idle';
    delete session.tempCartIdx;
    await saveSession(phone, session, env);
    return showMenuCategories(phone, session, env);
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
    session.state = 'entering_quantity';
    session.cartQtyEdit = true;
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `🔢 New quantity for *${session.cart[idx].name}*?\n\nTap a button or type a number (1–20):`,
      [
        { id: 'qty_2', title: '2' },
        { id: 'qty_3', title: '3' },
        { id: 'qty_5', title: '5' },
      ],
      env,
      null,
      'MENU | CART | CANCEL'
    );
  }

  if (msg.id === 'cart_item_notes') {
    session.state = 'entering_notes';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `📝 Notes for *${session.cart[idx].name}*:\n\nType your note and send, or tap *No Notes* to clear.`,
      [{ id: 'notes_none', title: 'No Notes' }],
      env
    );
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
  // Handle global commands to escape stuck state
  const t = (msg.text || '').toUpperCase().trim();
  const id = msg.id || '';
  if (t === 'CANCEL' || id === 'cmd_cancel') {
    session.state = 'cart_review';
    delete session.tempAddress;
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }
  if (t === 'CART' || id === 'cmd_cart') {
    session.state = 'cart_review';
    delete session.tempAddress;
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }
  if (t === 'MENU' || id === 'cmd_menu') {
    session.state = 'idle';
    delete session.tempAddress;
    await saveSession(phone, session, env);
    return showMenuCategories(phone, session, env);
  }

  const address = sanitize(msg.text || '', 300);
  if (address.length < 5) {
    return sendText(
      phone,
      '⚠️ Please enter a valid delivery address (at least 5 characters).\n\n' +
      'Include your street, building number, and apartment if applicable.\n' +
      'Example: *123 Main St, Apt 4B*\n\n' +
      'Send *CART* to view cart, *MENU* to browse, or *CANCEL* to abort.',
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
  const id = msg.id || '';

  if (t === 'CANCEL' || id === 'cmd_cancel') {
    session.state = 'cart_review';
    delete session.tempAddress;
    delete session.tempOrderNotes;
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }
  if (t === 'CART' || id === 'cmd_cart') {
    session.state = 'cart_review';
    delete session.tempAddress;
    delete session.tempOrderNotes;
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }
  if (t === 'MENU' || id === 'cmd_menu') {
    session.state = 'idle';
    delete session.tempAddress;
    delete session.tempOrderNotes;
    await saveSession(phone, session, env);
    return showMenuCategories(phone, session, env);
  }

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
  const id = msg.id || '';

  // Handle global commands to escape stuck state
  if (t === 'CANCEL' || id === 'cmd_cancel') {
    session.state = 'cart_review';
    delete session.tempAddress;
    delete session.tempOrderNotes;
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }
  if (t === 'CART' || id === 'cmd_cart') {
    session.state = 'cart_review';
    delete session.tempAddress;
    delete session.tempOrderNotes;
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }
  if (t === 'MENU' || id === 'cmd_menu') {
    session.state = 'idle';
    delete session.tempAddress;
    delete session.tempOrderNotes;
    await saveSession(phone, session, env);
    return showMenuCategories(phone, session, env);
  }

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

      // 2. Initialize Flutterwave
      const amount = cartTotal(session.cart);
      const reference = `order_${orderId}_${Date.now()}`;

      let payData;
      try {
        payData = await initializeFlutterwaveTransaction({
          amount,
          txRef: reference,
          currency: 'NGN',
          customer: {
            email: 'customer@fastchow.bot',
            phone_number: phone,
            name: 'Customer'
          },
          metadata: { orderId, phone }
        }, env);

        // 3. Update order with Flutterwave details
        await updateOrderPayment(orderId, {
          payment_reference: reference,
          payment_url: payData.link,
          payment_access_code: null,
          payment_status: 'pending'
        }, env);
      } catch (payErr) {
        console.error('[Checkout] Flutterwave init failed:', payErr);
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
          `💰 Total: ${formatPrice(amount)}\n\n` +
          `💳 *Action Required:* Please complete your payment to confirm this order:\n\n` +
          `${payData.link}\n\n` +
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

  // Unknown input — re-prompt with action buttons (don't clobber session state)
  return sendButtons(
    phone,
    '⚠️ Tap a button below to continue with your order.',
    [
      { id: 'btn_place_order', title: '✅ Place Order' },
      { id: 'btn_edit_cart',   title: '✏️ Edit Order'  },
    ],
    env,
    'Confirm Your Order'
  );
}

async function handleConfirmCancel(phone, msg, session, env) {
  if (msg.id === 'confirm_cancel_yes') {
    const isCartClear = session.confirmCancelType === 'cart_clear';
    clearCart(session);
    session.state = 'idle';
    delete session.confirmCancelType;
    await saveSession(phone, session, env);
    const doneMsg = isCartClear
      ? '🧹 Cart cleared!'
      : '🚫 Order cancelled.';
    return sendButtons(
      phone,
      `${doneMsg}\n\nWhat would you like to do next?`,
      [{ id: 'cmd_menu', title: '🍽️ Browse Menu' }],
      env
    );
  }

  // No or any other input — return to cart
  delete session.confirmCancelType;
  session.state = 'cart_review';
  await saveSession(phone, session, env);
  return showCart(phone, session, env);
}

// ─────────────────────────────────────────────────────────────
// View helpers
// ─────────────────────────────────────────────────────────────

async function showWelcome(phone, env) {
  const session = await getSession(phone, env);
  const buttons = [
    { id: 'cmd_menu',   title: '🍽️ View Menu'  },
    { id: 'cmd_cart',   title: '🛒 My Cart'     },
    { id: 'cmd_orders', title: '📋 My Orders'   },
  ];
  if (session.adminUserMode) {
    buttons.push({ id: 'exit_user_mode', title: '🔧 Exit User Mode' });
  }
  return sendButtons(
    phone,
    `👋 Welcome to *FastChow*! 🍔🍕🥤\n\nOrder fresh food delivered to your door.\n\nWhat would you like to do?\n\nNeed help? Send *HELP* anytime.`,
    buttons,
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

// WhatsApp hard limit: 10 rows total per list message (not per section).
// For categories with >10 items we paginate: 9 items + 1 "Next Page" nav row.
const ITEMS_PER_PAGE = 9;

async function showItemsForCategory(phone, categoryId, categoryName, session, env, page = 0) {
  const menu  = await getMenuCached(env);
  const items = menu.itemsByCategory[categoryId] || [];

  if (!items.length) {
    return sendButtons(
      phone,
      `😕 No items available in *${categoryName}* right now.`,
      [{ id: 'cmd_menu', title: '⬅️ Categories' }],
      env
    );
  }

  const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);
  const pageItems  = items.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

  const rows = pageItems.map(item => {
    const priceStr = `₦${item.price.toFixed(2)}`;
    const maxDesc  = 72 - priceStr.length - 3;
    const desc     = (item.description || '').slice(0, Math.max(0, maxDesc));
    return {
      id:          `item_${item.id}`,
      title:       item.name.slice(0, 24),
      description: `${priceStr} — ${desc || 'Tap to order'}`,
    };
  });

  // Add navigation rows when there are multiple pages
  if (page > 0) {
    rows.push({ id: `page_prev_${categoryId}_${page - 1}`, title: '⬅️ Previous Page', description: `Page ${page} of ${totalPages}` });
  }
  if (page < totalPages - 1) {
    rows.push({ id: `page_next_${categoryId}_${page + 1}`, title: '➡️ Next Page', description: `Page ${page + 2} of ${totalPages}` });
  }

  session.state            = 'selecting_item';
  session.tempCategoryId   = categoryId;
  session.tempCategoryName = categoryName;
  await saveSession(phone, session, env);

  const pageLabel = totalPages > 1 ? ` — Page ${page + 1}/${totalPages}` : '';
  console.log('[User] showItemsForCategory:', categoryName, '| page:', page, '| rows:', rows.length);

  return sendList(
    phone,
    `🍽️ *${categoryName}*${pageLabel} (${items.length} items)\n\nSelect an item to see details:`,
    'Choose Item',
    [{ title: categoryName, rows }],
    env
  );
}

async function showItemDetail(phone, itemId, session, env) {
  const item = await getMenuItem(itemId, env);
  if (!item || !item.is_available) {
    return sendButtons(
      phone,
      '⚠️ This item is no longer available.',
      [{ id: 'cmd_menu', title: '🍽️ Back to Menu' }],
      env
    );
  }

  session.tempItemId = item.id;
  session.state      = 'item_detail';
  await saveSession(phone, session, env);

  const buttons = [
    { id: `qty_1_${item.id}`,      title: '➕ Add 1'      },
    { id: `qty_custom_${item.id}`, title: '🔢 Choose Qty' },
    { id: 'btn_back_menu',         title: '⬅️ Back'       },
  ];

  const bodyText = `*${item.name}*\n💰 ₦${item.price.toFixed(2)}\n\n${item.description || 'No description.'}`;
  const footer   = 'MENU | CART | HELP';

  if (item.image_url) {
    return sendImageButtons(phone, bodyText, buttons, item.image_url, env, footer);
  }

  return sendButtons(phone, bodyText, buttons, env, item.name, footer);
}

async function addItemToCartAndConfirm(phone, session, qty, env) {
  if (!session.tempItemId) {
    session.state = 'idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ Something went wrong. Send *MENU* to start over.', env);
  }

  const item = await getAvailableMenuItem(session.tempItemId, env);
  if (!item) {
    session.state      = 'idle';
    session.tempItemId = null;
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '⚠️ Sorry, this item is no longer available.',
      [{ id: 'cmd_menu', title: '🍽️ Browse Menu' }],
      env
    );
  }

  addToCart(session.cart, {
    itemId:    item.id,
    name:      item.name,
    qty,
    unitPrice: item.price,
    notes:     '',
  });

  session.state      = 'cart_review';
  session.tempItemId = null;
  session.tempQty    = null;
  await saveSession(phone, session, env);

  const total = cartTotal(session.cart).toFixed(2);
  return sendButtons(
    phone,
    `✅ Added *${item.name}* ×${qty} to cart!\n\n🛒 Cart total: ₦${total}`,
    [
      { id: 'btn_checkout_start', title: '✅ Checkout'  },
      { id: 'btn_keep_shopping',  title: '➕ Add More'  },
      { id: 'btn_manage_cart',    title: '✏️ Manage'    },
    ],
    env,
    'Item Added!'
  );
}

async function showCart(phone, session, env) {
  // BUG-29 FIX: Skip the KV write if we're already in cart_review state.
  if (session.state !== 'cart_review') {
    session.state = 'cart_review';
    await saveSession(phone, session, env);
  }

  if (!session.cart.length) {
    const buttons = [{ id: 'cmd_menu', title: '🍽️ Browse Menu' }];
    if (session.adminUserMode) {
      buttons.push({ id: 'exit_user_mode', title: '🔧 Exit User Mode' });
    }
    return sendButtons(
      phone,
      '🛒 Your cart is empty.\nBrowse our menu to add items!',
      buttons,
      env
    );
  }

  const summary = cartSummary(session.cart);
  const buttons = [
    { id: 'btn_checkout_start', title: '✅ Checkout'     },
    { id: 'btn_keep_shopping',  title: '➕ Add More'     },
    { id: 'btn_manage_cart',    title: '✏️ Manage'       },
  ];
  if (session.adminUserMode) {
    buttons.push({ id: 'exit_user_mode', title: '🔧 Exit User Mode' });
  }
  return sendButtons(
    phone,
    `🛒 *Your Cart*\n\n${summary}`,
    buttons,
    env,
    'Shopping Cart'
  );
}

async function showOrderHistory(phone, session, env) {
  session.state = 'order_tracking';
  await saveSession(phone, session, env);

  const orders = await getUserOrders(phone, env);
  if (!orders.length) {
    session.state = 'idle';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '📋 You have no previous orders yet.\n\nStart by browsing our menu!',
      [{ id: 'cmd_menu', title: '🍽️ Browse Menu' }],
      env
    );
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

// Silently verify payment with Flutterwave and update if confirmed paid.
// Catches orders where the webhook was missed.
async function recoverPaymentIfNeeded(order, env) {
  if (order.payment_status === 'paid' || !order.payment_reference) return order;
  try {
    const { verifyFlutterwaveTransaction } = await import('../payments/flutterwave.js');
    const data = await verifyFlutterwaveTransaction(order.payment_reference, env);
    if (data.status === 'successful' && Math.abs(data.amount - order.total_price) <= 0.01) {
      await updateOrderPayment(order.id, { payment_status: 'paid', paid_at: new Date().toISOString() }, env);
      order.payment_status = 'paid';
    }
  } catch (err) {
    console.warn('[OrderTracking] Payment recovery check failed:', err.message);
  }
  return order;
}

async function handleOrderTracking(phone, msg, session, env) {
  if (msg.type === 'list_reply' && msg.id?.startsWith('track_')) {
    const orderId = parseInt(msg.id.replace('track_', ''), 10);
    let order = await getOrder(orderId, env);
    if (!order) return showOrderHistory(phone, session, env);
    order = await recoverPaymentIfNeeded(order, env);

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
        { id: 'cmd_orders', title: '⬅️ Order History' },
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
