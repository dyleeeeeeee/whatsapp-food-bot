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
  sendCtaUrl, sendLocationRequest, sendFlow,
} from '../whatsapp.js';
import {
  getSession, saveSession,
  addToCart, cartSummary, cartTotal, serviceFee, clearCart,
  getCachedMenu,  // BUG-01 FIX: was wrongly imported from db.js
  cacheMenu,      // BUG-01 FIX: was wrongly imported from db.js
  formatPrice,
} from '../session.js';
import {
  getFullMenu, getMenuItem, getAvailableMenuItem, createOrder, getUserOrders, getOrder,
  updateOrderPayment, markOrderPaidAtomic, getOrderByReference, persistTransactionId,
  saveCustomerAddress, getCustomerAddress,
} from '../db.js';
import { initializeFlutterwaveTransaction } from '../payments/flutterwave.js';
import { sanitize, hasMinAlphaNum } from '../security.js';

// Maximum chars in checkout confirm body (WhatsApp cap: 1024)
const CONFIRM_BODY_MAX = 900;

// EDGE-13: order-tracking body budget — collapse items above this length.
const TRACKING_BODY_MAX = 1000;

// EDGE-03: shared quantity-parse helper. Extracts the first integer in the
// string and accepts it only when it falls in the 1–20 range. Returns null
// for anything else (callers reuse the same warning copy).
const QTY_ERROR = '⚠️ Please enter a number from 1 to 20';

function parseQuantity(text) {
  const m = (text || '').match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (n >= 1 && n <= 20) return n;
  return null;
}

// UX-07: a List of quantities 1–10 (ids qty_1..qty_10) so the user can tap
// instead of typing. Used from the "Choose Qty" branch.
function quantityListSections() {
  const rows = [];
  for (let n = 1; n <= 10; n++) {
    rows.push({ id: `qty_${n}`, title: String(n), description: `Add ${n}` });
  }
  return [{ title: 'Quantity', rows }];
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export async function handleUserMessage(phone, msg, env, preSession = null) {
  // BUG-13: reuse the caller-provided session when batching messages.
  const session = preSession || await getSession(phone, env);

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
  // UX-05: a Reorder tap is only ever offered on the order-detail view.
  // genlink_ (re-init a failed payment) is likewise only offered there.
  if (id.startsWith('reorder_') || id.startsWith('genlink_') || (id.startsWith('track_') && msg.type === 'list_reply')) return 'order_tracking';
  // UX-02/UX-04: saved-address tap, shared location, or a completed checkout
  // Flow all belong to the address-capture step (only meaningful with a cart).
  if (id === 'use_saved_address') return 'checkout_address';
  if ((msg.type === 'location' || msg.type === 'flow_reply') && session.cart && session.cart.length > 0) {
    return 'checkout_address';
  }

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
      delete session.checkoutId; // BLOCKER #2: leaving user mode abandons checkout
      await saveSession(phone, session, env);
      return sendText(phone, '🔧 *User Mode Exited*\n\nReturning to Admin Panel.', env)
        .then(() => import('../handlers/admin.js').then(m => m.handleAdminMessage(phone, { type: 'button_reply', id: 'admin_home' }, env)));
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
    delete session.checkoutId; // BLOCKER #2: fresh cart → fresh idempotency key
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
      '_Commands work in any case — "menu", "MENU" or "Menu" all work._\n\n' +
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
  // EDGE-01 + BUG-12: a stranded address/notes message (free text with no
  // button id) usually means the session timed out mid-checkout. Tell the
  // user plainly instead of silently bouncing them to the welcome card.
  const text = (msg.text || '').trim();
  if (msg.type === 'text' && !msg.id && looksLikeAddress(text)) {
    return sendText(
      phone,
      '⌛ Your session timed out — send *MENU* to start again.',
      env
    );
  }
  return showWelcome(phone, env);
}

// Heuristic for "stranded" free text: long-ish, multi-word, contains letters.
// Single greetings/short commands are handled as global commands earlier.
function looksLikeAddress(text) {
  if (text.length < 8) return false;
  if (!/[a-z]/i.test(text)) return false;
  return text.split(/\s+/).length >= 2;
}

// EDGE-10: when a state expects a list/button tap but stray text arrives,
// surface a short notice before re-rendering the options so the user isn't
// silently shown the same screen.
const STRAY_TEXT_NOTICE = "I didn't catch that — pick an option, or send MENU/HELP";

function isStrayText(msg) {
  return msg.type === 'text' && !msg.id && (msg.text || '').trim().length > 0;
}

async function handleBrowsingMenu(phone, msg, session, env) {
  // BUG-16 FIX: removed dead `cmd_checkout` branch — no button with that ID exists
  if (msg.type === 'list_reply' && msg.id?.startsWith('cat_')) {
    const categoryId = parseInt(msg.id.replace('cat_', ''), 10);
    return showItemsForCategory(phone, categoryId, msg.title, session, env);
  }
  if (isStrayText(msg)) {
    await sendText(phone, STRAY_TEXT_NOTICE, env);
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

  if (isStrayText(msg)) {
    await sendText(phone, STRAY_TEXT_NOTICE, env);
    if (session.tempCategoryId) {
      return showItemsForCategory(
        phone, session.tempCategoryId, session.tempCategoryName || 'Menu', session, env,
        session.tempCategoryPage || 0
      );
    }
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

  // Custom quantity: UX-07 — send a List of quantities 1–10 (still accept text).
  if (id.startsWith('qty_custom_')) {
    session.state = 'entering_quantity';
    await saveSession(phone, session, env);
    return sendList(
      phone,
      '🔢 How many would you like?\n\nPick a quantity, or type any number (1–20):',
      'Choose Qty',
      quantityListSections(),
      env
    );
  }

  if (msg.id === 'btn_back_menu') {
    session.tempItemId = null;
    await saveSession(phone, session, env);
    // Return to the category the user came from, not the top-level menu
    if (session.tempCategoryId) {
      return showItemsForCategory(
        phone, session.tempCategoryId, session.tempCategoryName || 'Menu', session, env,
        session.tempCategoryPage || 0
      );
    }
    return showMenuCategories(phone, session, env);
  }

  // Numeric text while on item_detail = treat as qty (handles KV race)
  const qty = parseQuantity(msg.text);
  if (qty !== null) {
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
  // Button/list qty selection (qty_1..qty_10 from UX-07, plus legacy qty_N)
  if (msg.id?.startsWith('qty_') && /^qty_\d+$/.test(msg.id)) {
    const picked = parseInt(msg.id.replace('qty_', ''), 10);
    if (picked >= 1 && picked <= 20) {
      if (session.cartQtyEdit) return updateCartQty(phone, session, picked, env);
      return addItemToCartAndConfirm(phone, session, picked, env);
    }
  }

  // Text-based qty (EDGE-03: shared parse + shared warning copy)
  const qty = parseQuantity(msg.text);
  if (qty === null) {
    return sendList(
      phone,
      `${QTY_ERROR}, or pick one below:`,
      'Choose Qty',
      quantityListSections(),
      env
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
    return startCheckout(phone, session, env);
  }
  if (msg.id === 'btn_keep_shopping') return showMenuCategories(phone, session, env);
  
  if (msg.id === 'btn_manage_cart') {
    if (!session.cart.length) return showCart(phone, session, env);
    session.state = 'cart_manage';
    await saveSession(phone, session, env);
    
    // EDGE-05: embed the itemId in the row id so a stale list (cart mutated
    // since render) is detected before we mutate the wrong line.
    const rows = session.cart.map((item, idx) => ({
      id: `cart_idx_${idx}_${item.itemId}`,
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
    // EDGE-05: id format is cart_idx_{N}_{itemId}. Verify the embedded itemId
    // still matches cart[N] before mutating; on mismatch, re-render the cart.
    const parts = msg.id.split('_');             // ['cart','idx','N','itemId']
    const idx = parseInt(parts[2], 10);
    const embeddedItemId = parseInt(parts[3], 10);
    const item = session.cart[idx];
    if (!item || item.itemId !== embeddedItemId) {
      return showCart(phone, session, env);
    }

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
    return sendList(
      phone,
      `🔢 New quantity for *${session.cart[idx].name}*?\n\nPick one, or type a number (1–20):`,
      'Choose Qty',
      quantityListSections(),
      env
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

// Begin checkout: pick the address-capture flow based on env.
//   UX-04: env.CHECKOUT_FLOW_ID set → send a WhatsApp Flow (address + notes
//          in one shot, handled via flow_reply in checkout_address).
//   UX-02: else → native location request + a "Use saved address" button
//          when we have a remembered address for this customer.
async function startCheckout(phone, session, env) {
  session.state = 'checkout_address';

  // BLOCKER #2 (idempotency): mint a stable checkout id ONCE, the first time
  // this cart heads to checkout. It becomes the order's payment_reference
  // (idempotencyKey) so a double-tap / webhook retry / KV-race re-entry on
  // Place Order collides on the UNIQUE constraint instead of double-charging.
  // It survives Back/Edit within this checkout and is only cleared once the
  // order completes or the cart is cancelled.
  if (!session.checkoutId) {
    session.checkoutId = crypto.randomUUID();
  }
  await saveSession(phone, session, env);

  // UX-04: hosted Flow path (only when the flag is set — falls back otherwise).
  if (env.CHECKOUT_FLOW_ID) {
    try {
      return await sendFlow(
        phone,
        '🧾 Tap below to enter your delivery details.',
        {
          flowId:   env.CHECKOUT_FLOW_ID,
          flowToken: `checkout_${phone}_${Date.now()}`,
          flowCta:  'Checkout',
          screenId: env.CHECKOUT_FLOW_SCREEN_ID || 'CHECKOUT',
          data:     {},
        },
        env
      );
    } catch (err) {
      console.error('[Checkout] Flow send failed, falling back to text address capture:', err);
      // fall through to the native/text address capture so checkout never stalls
    }
  }

  return promptForAddress(phone, session, env);
}

// UX-02: ask for the delivery address. Offers a native location-request
// button; if we have a saved address, also offer a "Use saved address" tap.
async function promptForAddress(phone, session, env) {
  const saved = await getCustomerAddress(phone, env);
  if (saved) {
    session.tempSavedAddress = saved;
    await saveSession(phone, session, env);
    await sendButtons(
      phone,
      `📍 Deliver to your saved address?\n\n*${saved}*\n\n` +
      'Tap *Use saved address*, share your location, or just type a new address.',
      [{ id: 'use_saved_address', title: '📍 Use saved' }],
      env
    );
  } else if (session.tempSavedAddress) {
    delete session.tempSavedAddress;
    await saveSession(phone, session, env);
  }

  return sendLocationRequest(
    phone,
    '📍 Share your *delivery location*, or type your full address as text.',
    env
  );
}

async function handleCheckoutAddress(phone, msg, session, env) {
  // Handle global commands to escape stuck state
  const t = (msg.text || '').toUpperCase().trim();
  const id = msg.id || '';
  if (t === 'CANCEL' || id === 'cmd_cancel') {
    session.state = 'cart_review';
    delete session.tempAddress;
    delete session.tempSavedAddress;
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }
  if (t === 'CART' || id === 'cmd_cart') {
    session.state = 'cart_review';
    delete session.tempAddress;
    delete session.tempSavedAddress;
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }
  if (t === 'MENU' || id === 'cmd_menu') {
    session.state = 'idle';
    delete session.tempAddress;
    delete session.tempSavedAddress;
    await saveSession(phone, session, env);
    return showMenuCategories(phone, session, env);
  }

  // UX-04: a completed checkout Flow fills address + notes in one shot.
  if (msg.type === 'flow_reply' && msg.data) {
    const flowAddr  = sanitize(String(msg.data.address || msg.data.delivery_address || ''), 300);
    const flowNotes = sanitize(String(msg.data.notes || msg.data.delivery_notes || ''), 200);
    if (hasMinAlphaNum(flowAddr, 3) && flowAddr.length >= 5) {
      session.tempAddress    = flowAddr;
      session.tempOrderNotes = flowNotes;
      return finishAddressStep(phone, session, env, /*skipNotes=*/true);
    }
    // Flow returned an unusable address — fall back to manual capture.
    return promptForAddress(phone, session, env);
  }

  // UX-02: user shared a location pin → compose an address string.
  if (msg.type === 'location') {
    const parts = [];
    if (msg.name)    parts.push(msg.name);
    if (msg.address) parts.push(msg.address);
    let composed = parts.join(', ');
    if (!composed && (msg.latitude != null && msg.longitude != null)) {
      composed = `Pinned location (${msg.latitude}, ${msg.longitude})`;
    }
    const address = sanitize(composed, 300);
    if (!hasMinAlphaNum(address, 3) || address.length < 5) {
      return sendLocationRequest(
        phone,
        '⚠️ I couldn\'t read that location. Please type your full delivery address as text.',
        env
      );
    }
    session.tempAddress = address;
    return finishAddressStep(phone, session, env);
  }

  // UX-02: reuse the saved address.
  if (id === 'use_saved_address' && session.tempSavedAddress) {
    session.tempAddress = session.tempSavedAddress;
    return finishAddressStep(phone, session, env);
  }

  const address = sanitize(msg.text || '', 300);
  // EDGE-16: reject pure emoji/whitespace — require at least 3 alphanumerics.
  if (address.length < 5 || !hasMinAlphaNum(address, 3)) {
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
  return finishAddressStep(phone, session, env);
}

// Shared tail of the address step. When skipNotes is true (Flow already
// supplied notes) we jump straight to the confirm screen.
async function finishAddressStep(phone, session, env, skipNotes = false) {
  delete session.tempSavedAddress;

  if (skipNotes) {
    return renderCheckoutConfirm(phone, session, env);
  }

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
    return promptForAddress(phone, session, env);
  }

  const notes = msg.id === 'delivery_notes_skip'
    ? ''
    : sanitize(msg.text || '', 200);

  session.tempOrderNotes = notes;
  return renderCheckoutConfirm(phone, session, env);
}

// Build and send the order-confirmation screen. Shared by the text flow and
// the one-shot Flow path (UX-04). Sets state to checkout_confirm.
async function renderCheckoutConfirm(phone, session, env) {
  session.state = 'checkout_confirm';
  await saveSession(phone, session, env);

  const address = session.tempAddress || '';
  const orderNotes = session.tempOrderNotes || '';

  // BUG-08 FIX: Checkout confirm body can exceed 1024 chars with many items.
  // We build the summary first and truncate intelligently if needed.
  const subtotal = cartTotal(session.cart);
  const fee      = serviceFee(subtotal);
  const grand    = subtotal + fee;
  // Item lines only — the subtotal/fee/total breakdown lives in the suffix.
  let   summary  = cartSummary(session.cart, { withTotal: false });

  // Budget: prefix + summary + address + notes + suffix
  const prefix  = `🧾 *Order Summary*\n\n`;
  let middle    = `\n\n📍 *Address:* ${address}`;
  if (orderNotes) middle += `\n📝 *Instructions:* ${orderNotes}`;
  const suffix  =
    `\n\n🧮 *Subtotal: ₦${subtotal.toFixed(2)}*` +
    `\n➕ *Service fee: ₦${fee.toFixed(2)}*` +
    `\n💳 *Total: ₦${grand.toFixed(2)}*` +
    `\n\nReady to place your order?`;
  const budget  = CONFIRM_BODY_MAX - prefix.length - middle.length - suffix.length;

  if (summary.length > budget) {
    const count  = session.cart.length;
    summary = `${count} item${count !== 1 ? 's' : ''} in your order.`;
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
    return placeOrder(phone, session, env);
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

// ─────────────────────────────────────────────────────────────
// Place Order — re-validate, re-price, guard, create, pay
// ─────────────────────────────────────────────────────────────

// BUG-10: a double-tap on "Place Order" must not create two orders. We use a
// SETNX-style KV guard keyed by phone. get → if present, ignore; else put with
// a short TTL. Always cleared in a finally so a crash can't wedge the user.
async function placeOrder(phone, session, env) {
  const lockKey = 'placing:' + phone;
  const held = await env.SESSION_KV.get(lockKey);
  if (held) {
    console.log('[Checkout] Duplicate Place Order tap ignored for', phone);
    return; // swallow the duplicate tap
  }
  await env.SESSION_KV.put(lockKey, '1', { expirationTtl: 60 });

  try {
    // BUG-02 + EDGE-04: guard an empty cart before doing anything else.
    if (!session.cart.length) {
      session.state = 'cart_review';
      await saveSession(phone, session, env);
      await sendText(phone, '🛒 Your cart is empty. Browse the menu to add items.', env);
      return showCart(phone, session, env);
    }

    // BUG-02 + EDGE-04: re-validate every line against the live menu. Drop any
    // item that was deleted or turned unavailable since it was added.
    // BUG-01 + BUG-18 + EDGE-12: re-price each surviving line from the live
    // price and surface a notice for any change before payment.
    const survivors = [];
    const removed = [];
    const repriced = [];

    for (const line of session.cart) {
      const item = await getAvailableMenuItem(line.itemId, env);
      if (!item) {
        removed.push(line.name);
        continue;
      }
      if (Math.round(item.price * 100) !== Math.round(line.unitPrice * 100)) {
        repriced.push({ name: item.name, price: item.price });
        line.unitPrice = item.price;
      }
      survivors.push(line);
    }

    if (removed.length) {
      session.cart = survivors;
      session.state = 'cart_review';
      await saveSession(phone, session, env);
      await sendText(
        phone,
        `⚠️ Some items are no longer available and were removed:\n` +
        removed.map(n => `• ${n}`).join('\n') +
        `\n\nPlease review your cart before checking out.`,
        env
      );
      return showCart(phone, session, env);
    }

    // BUG-01 + BUG-18 + EDGE-12: prices changed — apply, notify, then continue.
    if (repriced.length) {
      session.cart = survivors;
      await saveSession(phone, session, env);
      for (const r of repriced) {
        await sendText(
          phone,
          `ℹ️ price for ${r.name} updated to ${formatPrice(r.price)}`,
          env
        );
      }
    }

    const subtotal = cartTotal(session.cart);
    if (!(subtotal > 0)) {
      session.state = 'cart_review';
      await saveSession(phone, session, env);
      await sendText(phone, '⚠️ Your order total is invalid. Please review your cart.', env);
      return showCart(phone, session, env);
    }
    // Charge the fee-inclusive total. createOrder computes the same fee from
    // the same items server-side, so the charged amount matches total_price.
    const amount = subtotal + serviceFee(subtotal);

    // BLOCKER #2 (idempotency): the order's payment_reference IS the checkout
    // id minted once at startCheckout. createOrder writes it into the UNIQUE
    // payment_reference column in the same insert, so a duplicate placement
    // (double-tap that beat the KV lock, webhook retry, KV-race re-entry)
    // collides and throws .code='IDEMPOTENT_DUPLICATE' — we then fetch and
    // REUSE the existing order's payment link instead of creating a second
    // order (no double charge). Mint here too as a belt-and-suspenders guard
    // in case confirm was reached via stale-state recovery.
    if (!session.checkoutId) {
      session.checkoutId = crypto.randomUUID();
      await saveSession(phone, session, env);
    }
    const reference = `FCHOW-${session.checkoutId}`;

    let orderId;
    let reused = false;
    try {
      orderId = await createOrder(
        {
          userPhone:  phone,
          address:    session.tempAddress || '',
          orderNotes: session.tempOrderNotes || '',
          items:      session.cart,
          idempotencyKey: reference,
        },
        env
      );
    } catch (createErr) {
      if (createErr && createErr.code === 'IDEMPOTENT_DUPLICATE') {
        // Same reference already produced an order — fetch + reuse it so we
        // never create a duplicate or charge twice.
        const existing = await getOrderByReference(reference, env);
        if (!existing) throw createErr; // shouldn't happen; let outer catch handle
        orderId = existing.id;
        reused = true;
        console.log('[Checkout] Reusing existing order', orderId, 'for', reference);
      } else {
        throw createErr;
      }
    }

    // Resolve a payment link: reuse the persisted one on a duplicate, otherwise
    // init Flutterwave against the SAME reference and persist the link + tx id.
    const link = await ensurePaymentLink(orderId, reference, amount, phone, env, reused);

    // UX-02: remember the address for next time, now that the order exists.
    const placedAddress = session.tempAddress || '';
    if (placedAddress) {
      await saveCustomerAddress(phone, placedAddress, env);
    }

    // Order is committed. Clear cart + checkout id so the next order is fresh,
    // and so a future Place Order can't re-collide on this reference.
    clearCart(session);
    session.state = 'idle';
    delete session.tempAddress;
    delete session.tempOrderNotes;
    delete session.tempSavedAddress;
    delete session.checkoutId;
    await saveSession(phone, session, env);

    // BLOCKER (send-failure swallowed as order failure): the order is already
    // created above. A 5xx from WhatsApp on these follow-up sends must NOT
    // bubble to the outer catch and tell the user "order failed" — that would
    // imply the order didn't happen when it did. Swallow send errors here; the
    // user can always reach the order (and re-init the pay link) via ORDERS.
    try {
      if (link) {
        // UX-01: send the detail first, then the pay link as a CTA URL button.
        await sendText(
          phone,
          `🎉 *Order #${orderId} placed!*\n\n` +
          `💰 Total: ${formatPrice(amount)}\n\n` +
          `💳 *Action Required:* Tap *Pay Now* to complete your payment.\n\n` +
          `Once paid, we will begin preparing your meal! Track anytime with *ORDERS*.`,
          env
        );
        return await sendCtaUrl(
          phone,
          `💳 Complete payment for Order #${orderId} — ${formatPrice(amount)}`,
          'Pay Now',
          link,
          env
        );
      }
      // BLOCKER (failed-init dead-end): no link — offer an explicit retry that
      // re-inits against the persisted reference from the order-tracking view.
      return await sendButtons(
        phone,
        `🎉 *Order #${orderId} placed!*\n\n` +
        `⚠️ We had trouble creating your payment link. Tap *Generate payment link* to try again, or find it under *My Orders*.`,
        [
          { id: `genlink_${orderId}`, title: '💳 Generate link' },
          { id: 'cmd_orders',         title: '📋 My Orders'     },
        ],
        env
      );
    } catch (sendErr) {
      console.error('[Checkout] Post-order follow-up send failed (order IS placed):', sendErr);
      return; // order succeeded; do not report failure to the user
    }
  } catch (err) {
    console.error('[Checkout] placeOrder failed:', err);
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
  } finally {
    // BUG-10: always release the guard so the next legitimate attempt works.
    await env.SESSION_KV.delete(lockKey).catch(() => {});
  }
}

// Resolve a Flutterwave payment link for an order against its persisted
// reference. Reuses the already-stored link on a duplicate (no second charge);
// otherwise inits Flutterwave with the SAME reference and persists the link +
// transaction id. Never throws — a failed init returns null so the caller can
// offer a "Generate payment link" retry instead of dead-ending the order.
async function ensurePaymentLink(orderId, reference, amount, phone, env, reused = false) {
  if (reused) {
    const existing = await getOrder(orderId, env).catch(() => null);
    if (existing && existing.payment_url) return existing.payment_url;
    // Duplicate order exists but never got a link (prior init failed) — fall
    // through and init now against the same reference.
  }

  try {
    const payData = await initializeFlutterwaveTransaction({
      amount,
      txRef: reference,
      currency: 'NGN',
      customer: {
        email: 'customer@fastchow.bot',
        phone_number: phone,
        name: 'Customer',
      },
      metadata: { orderId, phone },
    }, env);

    await updateOrderPayment(orderId, { payment_url: payData.link }, env);

    // Persist the Flutterwave transaction id when present (off the critical
    // path — best effort, must not block the link from being returned).
    if (payData.id != null) {
      await persistTransactionId(orderId, payData.id, env).catch((e) =>
        console.warn('[Checkout] persistTransactionId failed:', e && e.message)
      );
    }

    return payData.link;
  } catch (payErr) {
    console.error('[Checkout] Flutterwave init failed:', payErr);
    return null; // order + reference are persisted; user can Generate link later
  }
}

async function handleConfirmCancel(phone, msg, session, env) {
  if (msg.id === 'confirm_cancel_yes') {
    const isCartClear = session.confirmCancelType === 'cart_clear';
    clearCart(session);
    session.state = 'idle';
    delete session.confirmCancelType;
    delete session.confirmCancelReprompted;
    // BLOCKER #2: cart is gone — drop the idempotency key so the next checkout
    // mints a fresh one (a brand-new cart is a brand-new order).
    delete session.checkoutId;
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

  // Explicit "No" — return to cart.
  if (msg.id === 'confirm_cancel_no') {
    delete session.confirmCancelType;
    delete session.confirmCancelReprompted;
    session.state = 'cart_review';
    await saveSession(phone, session, env);
    return showCart(phone, session, env);
  }

  // EDGE-18: unrecognized input — re-prompt Yes/No exactly once before
  // defaulting to "No" so a stray tap doesn't silently abandon the prompt.
  if (!session.confirmCancelReprompted) {
    session.confirmCancelReprompted = true;
    await saveSession(phone, session, env);
    const isCartClear = session.confirmCancelType === 'cart_clear';
    return sendButtons(
      phone,
      isCartClear
        ? '❓ Please choose: clear your entire cart?'
        : '❓ Please choose: cancel your current order?',
      [
        { id: 'confirm_cancel_yes', title: isCartClear ? 'Yes, Clear' : 'Yes, Cancel' },
        { id: 'confirm_cancel_no',  title: 'No, Keep it' },
      ],
      env
    );
  }

  // Second unrecognized input — fall back to "No".
  delete session.confirmCancelType;
  delete session.confirmCancelReprompted;
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

// WhatsApp hard-caps an interactive list at 10 TOTAL rows across all sections
// and SILENTLY DROPS the overflow (see listPayload). A middle page carries up
// to three nav rows — Previous + Next + Categories — so we reserve those slots
// and show at most 7 items per page. This is what makes multi-page navigation
// work: at 9 items/page the "Next" row was the 11th row and got dropped,
// stranding users on page 2 (they could go back but never forward).
const LIST_MAX_ROWS = 10;
const MAX_NAV_ROWS  = 3; // Previous + Next + Categories (worst case, a middle page)
const ITEMS_PER_PAGE = LIST_MAX_ROWS - MAX_NAV_ROWS; // 7

// Pure row-builder for one page of a category's item list. Exported for tests.
// Guarantees rows.length <= LIST_MAX_ROWS and clamps an out-of-range `page`
// (e.g. a stale nav tap after the menu shrank) to a valid page instead of
// rendering an empty list.
export function buildMenuListRows(items, categoryId, page = 0) {
  const totalPages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
  const safePage   = Math.min(Math.max(page | 0, 0), totalPages - 1);
  const pageItems  = items.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE);

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

  // Pagination controls, then a persistent escape to the category list. The
  // last page omits "Next" and the first omits "Previous" — WhatsApp lists have
  // no disabled/greyed state, so an unavailable direction is simply not shown.
  if (safePage > 0) {
    rows.push({ id: `page_prev_${categoryId}_${safePage - 1}`, title: '⬅️ Previous', description: `Back to page ${safePage} of ${totalPages}` });
  }
  if (safePage < totalPages - 1) {
    rows.push({ id: `page_next_${categoryId}_${safePage + 1}`, title: '➡️ Next', description: `Go to page ${safePage + 2} of ${totalPages}` });
  }
  rows.push({ id: 'cmd_menu', title: '🗂️ Categories', description: 'Back to all categories' });

  return { rows, totalPages, page: safePage };
}

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

  const { rows, totalPages, page: safePage } = buildMenuListRows(items, categoryId, page);

  session.state            = 'selecting_item';
  session.tempCategoryId   = categoryId;
  session.tempCategoryName = categoryName;
  session.tempCategoryPage = safePage; // so "Back" from item detail returns here
  await saveSession(phone, session, env);

  const pageLabel = totalPages > 1 ? ` — Page ${safePage + 1}/${totalPages}` : '';
  console.log('[User] showItemsForCategory:', categoryName, '| page:', safePage, '| rows:', rows.length);

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
    // Assert the verified transaction is genuinely successful, in the expected
    // currency (NGN), and for the right amount before flipping to paid — a
    // mismatched currency means the verified amount isn't comparable to our
    // NGN total, so we must NOT mark it paid.
    if (
      data.status === 'successful' &&
      data.currency === 'NGN' &&
      Math.abs(data.amount - order.total_price) <= 0.01
    ) {
      // Route through the single paid-transition chokepoint so the flip is
      // atomic + idempotent (won't double-fire side effects vs. the webhook).
      const { changed } = await markOrderPaidAtomic(order.id, new Date().toISOString(), env);
      if (changed && data.id != null) {
        await persistTransactionId(order.id, data.id, env).catch(() => {});
      }
      order.payment_status = 'paid';
    }
  } catch (err) {
    console.warn('[OrderTracking] Payment recovery check failed:', err.message);
  }
  return order;
}

async function handleOrderTracking(phone, msg, session, env) {
  // UX-05: rebuild the cart from a past order and jump to cart review.
  if (msg.id?.startsWith('reorder_')) {
    const orderId = parseInt(msg.id.replace('reorder_', ''), 10);
    return reorder(phone, session, orderId, env);
  }

  // BLOCKER (failed-init dead-end): re-init Flutterwave against the order's
  // PERSISTED reference and hand back a Pay Now link. Reuses the same reference
  // so this never creates a second charge.
  if (msg.id?.startsWith('genlink_')) {
    const orderId = parseInt(msg.id.replace('genlink_', ''), 10);
    return generatePaymentLink(phone, session, orderId, env);
  }

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

    const paymentEmoji = {
      paid: '✅ Paid',
      pending: '⏳ Pending',
      unpaid: '❌ Unpaid',
      failed: '⚠️ Failed'
    };

    const head =
      `📦 *Order #${order.id} Details*\n\n` +
      `*Status:* ${statusEmoji[order.status] || order.status}\n` +
      `_${statusDesc[order.status] || ''}_\n\n` +
      `*Payment:* ${paymentEmoji[order.payment_status] || order.payment_status}\n`;

    const tail =
      `*Total:* ${formatPrice(order.total_price)}\n` +
      `*Address:* ${order.address}\n` +
      `*Notes:* ${order.notes || 'None'}\n\n` +
      `*Placed on:* ${order.created_at}`;

    // EDGE-13: budget the body. If the full item list would push the message
    // past TRACKING_BODY_MAX, collapse it to "N items — ₦total" so nothing
    // gets hard-truncated mid-line.
    const fullItems = order.items.map(i => `• ${i.name} x${i.quantity}`).join('\n');
    const itemCount = order.items.length;
    const collapsed = `${itemCount} item${itemCount !== 1 ? 's' : ''} — ${formatPrice(order.total_price)}`;
    const fullBody  = `${head}\n*Items:*\n${fullItems}\n\n${tail}`;
    const itemsBlock = fullBody.length > TRACKING_BODY_MAX ? collapsed : fullItems;
    const body = `${head}\n*Items:*\n${itemsBlock}\n\n${tail}`;

    const buttons = [
      { id: 'cmd_orders',           title: '⬅️ Order History' },
      { id: `reorder_${order.id}`,  title: '🔁 Reorder'       },
      { id: 'cmd_menu',             title: '🍽️ View Menu'     },
    ];

    // UX-01: send the detail first, then the pay link as a CTA URL button.
    await sendButtons(phone, body, buttons, env);

    if (order.payment_status !== 'paid' && order.status !== 'cancelled') {
      if (order.payment_url) {
        return sendCtaUrl(
          phone,
          `💳 Complete payment for Order #${order.id} — ${formatPrice(order.total_price)}`,
          'Pay Now',
          order.payment_url,
          env
        );
      }
      // BLOCKER (failed-init dead-end): no link was ever created (init failed at
      // checkout). Offer an explicit retry that re-inits the persisted reference.
      return sendButtons(
        phone,
        `💳 No payment link yet for Order #${order.id}. Tap below to generate one.`,
        [{ id: `genlink_${order.id}`, title: '💳 Generate link' }],
        env
      );
    }
    return;
  }

  if (isStrayText(msg)) {
    await sendText(phone, STRAY_TEXT_NOTICE, env);
  }
  return showOrderHistory(phone, session, env);
}

// BLOCKER (failed-init dead-end): generate (or reuse) a Flutterwave payment
// link for an existing unpaid order, keyed by its PERSISTED reference so we
// never create a second charge. Sends a Pay Now CTA on success.
async function generatePaymentLink(phone, session, orderId, env) {
  const order = await getOrder(orderId, env);
  if (!order) return showOrderHistory(phone, session, env);

  if (order.payment_status === 'paid') {
    return sendText(phone, `✅ Order #${orderId} is already paid. Nothing to do!`, env);
  }
  if (order.status === 'cancelled') {
    return sendText(phone, `❌ Order #${orderId} was cancelled — no payment is needed.`, env);
  }
  if (!order.payment_reference) {
    // No reference to re-init against (older order). Don't risk a mismatched
    // charge — point them to support via order history.
    return sendButtons(
      phone,
      `⚠️ We couldn't generate a payment link for Order #${orderId}. Please contact support.`,
      [{ id: 'cmd_orders', title: '📋 My Orders' }],
      env
    );
  }

  const link = await ensurePaymentLink(
    orderId,
    order.payment_reference,
    order.total_price,
    phone,
    env,
    Boolean(order.payment_url) // reuse the stored link if one already exists
  );

  if (link) {
    return sendCtaUrl(
      phone,
      `💳 Complete payment for Order #${orderId} — ${formatPrice(order.total_price)}`,
      'Pay Now',
      link,
      env
    );
  }

  return sendButtons(
    phone,
    `⚠️ We still couldn't reach the payment provider for Order #${orderId}. Please try again shortly.`,
    [{ id: `genlink_${orderId}`, title: '🔄 Try again' }],
    env
  );
}

// UX-05: rebuild session.cart from a past order. Re-validate each line against
// the live menu (skip gone items) and re-price from the current menu price.
async function reorder(phone, session, orderId, env) {
  const order = await getOrder(orderId, env);
  if (!order || !order.items.length) {
    await sendText(phone, '⚠️ Sorry, that order could not be loaded.', env);
    return showOrderHistory(phone, session, env);
  }

  const cart = [];
  const skipped = [];
  for (const oi of order.items) {
    const item = await getAvailableMenuItem(oi.menu_item_id, env);
    if (!item) {
      skipped.push(oi.name);
      continue;
    }
    addToCart(cart, {
      itemId:    item.id,
      name:      item.name,
      qty:       oi.quantity,
      unitPrice: item.price, // re-price live
      notes:     oi.notes || '',
    });
  }

  if (!cart.length) {
    await sendText(
      phone,
      '⚠️ None of the items from that order are available right now.',
      env
    );
    return showMenuCategories(phone, session, env);
  }

  session.cart  = cart;
  session.state = 'cart_review';
  await saveSession(phone, session, env);

  if (skipped.length) {
    await sendText(
      phone,
      `ℹ️ These items are no longer available and were skipped:\n` +
      skipped.map(n => `• ${n}`).join('\n'),
      env
    );
  }

  await sendText(phone, '🔁 Added your previous order to the cart!', env);
  return showCart(phone, session, env);
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
