/**
 * src/handlers/admin.js — Admin Command State Machine
 *
 * Admin states (stored in session.state):
 *   admin_idle                 → command menu
 *   admin_add_category         → entering category name
 *   admin_add_item_name        → item name input
 *   admin_add_item_category    → choose category
 *   admin_add_item_price       → price input
 *   admin_add_item_description → description input
 *   admin_add_item_image       → image URL (optional)
 *   admin_edit_item_select     → pick item to edit
 *   admin_edit_item_field      → pick field to change
 *   admin_edit_item_value      → enter new value
 *   admin_delete_item_select   → pick item to delete
 *   admin_delete_item_confirm  → confirm deletion
 *   admin_orders_list          → view pending orders
 *   admin_update_status_id     → enter order ID
 *   admin_update_status_value  → choose new status
 */

import {
  sendText, sendButtons, sendList,
} from '../whatsapp.js';
import {
  getSession, saveSession,
  bustMenuCache,
} from '../session.js';
import {
  getFullMenu, getMenuItem, getCategories,
  createMenuItem, updateMenuItem, deleteMenuItem,
  getPendingOrders, getOrder, updateOrderStatus,
} from '../db.js';
import { sanitize } from '../security.js';

const VALID_STATUSES = ['pending','confirmed','preparing','ready','delivered','cancelled'];

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export async function handleAdminMessage(phone, msg, env) {
  const session = await getSession(phone, env);

  // Ensure adminCtx always exists — old sessions may lack it
  session.adminCtx = session.adminCtx || {};

  // ADMIN command always resets to admin_idle
  const text = (msg.text || '').toUpperCase().trim();
  if (text === 'ADMIN' || msg.id === 'admin_home') {
    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return showAdminMenu(phone, env);
  }

  switch (session.state) {
    case 'admin_idle':
      return handleAdminIdle(phone, msg, session, env);
    case 'admin_add_category':
      return handleAddCategory(phone, msg, session, env);
    case 'admin_add_item_name':
      return handleAddItemName(phone, msg, session, env);
    case 'admin_add_item_category':
      return handleAddItemCategory(phone, msg, session, env);
    case 'admin_add_item_price':
      return handleAddItemPrice(phone, msg, session, env);
    case 'admin_add_item_description':
      return handleAddItemDescription(phone, msg, session, env);
    case 'admin_add_item_image':
      return handleAddItemImage(phone, msg, session, env);
    case 'admin_edit_item_select':
      return handleEditItemSelect(phone, msg, session, env);
    case 'admin_edit_item_field':
      return handleEditItemField(phone, msg, session, env);
    case 'admin_edit_item_value':
      return handleEditItemValue(phone, msg, session, env);
    case 'admin_delete_item_select':
      return handleDeleteItemSelect(phone, msg, session, env);
    case 'admin_delete_item_confirm':
      return handleDeleteItemConfirm(phone, msg, session, env);
    case 'admin_toggle_item_select':        // ← was missing entirely
      return handleToggleItemSelect(phone, msg, session, env);
    case 'admin_orders_list':
      return handleAdminOrdersList(phone, msg, session, env);
    case 'admin_update_status_id':
      return handleUpdateStatusId(phone, msg, session, env);
    case 'admin_update_status_value':
      return handleUpdateStatusValue(phone, msg, session, env);
    default:
      session.state = 'admin_idle';
      await saveSession(phone, session, env);
      return showAdminMenu(phone, env);
  }
}

// ─────────────────────────────────────────────────────────────
// Admin menu
// ─────────────────────────────────────────────────────────────

async function showAdminMenu(phone, env) {
  return sendList(
    phone,
    '🔧 *Admin Panel*\nWhat would you like to manage?',
    'Admin Actions',
    [
      {
        title: 'Menu Management',
        rows: [
          { id: 'admin_add_item',    title: 'Add Item',         description: 'Add a new menu item'          },
          { id: 'admin_edit_item',   title: 'Edit Item',        description: 'Update price, name, etc.'     },
          { id: 'admin_delete_item', title: 'Delete Item',      description: 'Remove item from menu'        },
          { id: 'admin_add_cat',     title: 'Add Category',     description: 'Create a new menu category'   },
          { id: 'admin_toggle_item', title: 'Toggle Avail.',    description: 'Mark item available/unavail.' },
        ],
      },
      {
        title: 'Orders',
        rows: [
          { id: 'admin_view_orders',    title: 'View Orders',     description: 'See pending/active orders'  },
          { id: 'admin_update_status',  title: 'Update Status',   description: 'Change an order status'     },
        ],
      },
    ],
    env
  );
}

async function handleAdminIdle(phone, msg, session, env) {
  const id = msg.id || '';

  if (id === 'admin_add_item') {
    session.state    = 'admin_add_item_name';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendText(phone, '➕ *Add New Item*\n\nEnter the item *name*:', env);
  }

  if (id === 'admin_add_cat') {
    session.state = 'admin_add_category';
    await saveSession(phone, session, env);
    return sendText(phone, '📂 Enter the new *category name*:', env);
  }

  if (id === 'admin_edit_item') {
    return startEditFlow(phone, session, env);
  }

  if (id === 'admin_delete_item') {
    return startDeleteFlow(phone, session, env);
  }

  if (id === 'admin_toggle_item') {
    return startToggleFlow(phone, session, env);
  }

  if (id === 'admin_view_orders') {
    return viewOrders(phone, session, env);
  }

  if (id === 'admin_update_status') {
    session.state = 'admin_update_status_id';
    await saveSession(phone, session, env);
    return sendText(phone, '📦 Enter the *Order ID* to update:', env);
  }

  // Fallback
  return showAdminMenu(phone, env);
}

// ─────────────────────────────────────────────────────────────
// Add Category
// ─────────────────────────────────────────────────────────────

async function handleAddCategory(phone, msg, session, env) {
  const name = sanitize(msg.text || '', 50);
  if (name.length < 2) {
    return sendText(phone, '⚠️ Category name must be at least 2 characters.', env);
  }

  try {
    await env.DB.prepare(
      'INSERT INTO MenuCategories (name) VALUES (?)'
    ).bind(name).run();
    await bustMenuCache(env);
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `✅ Category *${name}* created!`,
      [{ id: 'admin_home', title: '🔧 Admin Menu' }],
      env
    );
  } catch {
    return sendText(phone, `⚠️ Category "${name}" may already exist.`, env);
  }
}

// ─────────────────────────────────────────────────────────────
// Add Item — multi-step flow
// ─────────────────────────────────────────────────────────────

async function handleAddItemName(phone, msg, session, env) {
  const name = sanitize(msg.text || '', 100);
  if (name.length < 2) return sendText(phone, '⚠️ Name must be at least 2 characters.', env);

  session.adminCtx.newItem = { name };
  session.state = 'admin_add_item_category';
  await saveSession(phone, session, env);

  const cats = await getCategories(env);
  const rows = cats.map(c => ({ id: `acat_${c.id}`, title: c.name }));

  return sendList(
    phone,
    `📂 Choose a *category* for "${name}":`,
    'Select Category',
    [{ title: 'Categories', rows }],
    env
  );
}

async function handleAddItemCategory(phone, msg, session, env) {
  if (!msg.id?.startsWith('acat_')) {
    return sendText(phone, '⚠️ Please select a category from the list.', env);
  }
  // Guard: newItem must exist (corrupted session recovery)
  if (!session.adminCtx.newItem) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ Session lost. Please start over.', env);
  }
  const catId = parseInt(msg.id.replace('acat_', ''), 10);
  session.adminCtx.newItem.categoryId = catId;
  session.state = 'admin_add_item_price';
  await saveSession(phone, session, env);
  return sendText(phone, '💰 Enter the *price* (e.g. 9.99):', env);
}

async function handleAddItemPrice(phone, msg, session, env) {
  const price = parseFloat(msg.text || '');
  if (isNaN(price) || price < 0) {
    return sendText(phone, '⚠️ Enter a valid price (e.g. 9.99).', env);
  }
  session.adminCtx.newItem.price = price;
  session.state = 'admin_add_item_description';
  await saveSession(phone, session, env);
  return sendButtons(
    phone,
    '📝 Enter a *description* for this item:',
    [{ id: 'skip_desc', title: 'Skip' }],
    env
  );
}

async function handleAddItemDescription(phone, msg, session, env) {
  const desc = msg.id === 'skip_desc' ? '' : sanitize(msg.text || '', 300);
  session.adminCtx.newItem.description = desc;
  session.state = 'admin_add_item_image';
  await saveSession(phone, session, env);
  return sendButtons(
    phone,
    '🖼️ Enter an *image URL* for this item (or skip):',
    [{ id: 'skip_img', title: 'Skip' }],
    env
  );
}

async function handleAddItemImage(phone, msg, session, env) {
  const imageUrl = msg.id === 'skip_img' ? '' : sanitize(msg.text || '', 500);
  const item     = session.adminCtx.newItem;
  item.imageUrl  = imageUrl;

  const id = await createMenuItem(item, env);
  await bustMenuCache(env);

  session.state    = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `✅ *${item.name}* added to menu! (ID: ${id})\n💰 $${item.price.toFixed(2)}`,
    [{ id: 'admin_home', title: '🔧 Admin Menu' }],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// Edit Item
// ─────────────────────────────────────────────────────────────

async function startEditFlow(phone, session, env) {
  const menu  = await getFullMenu(env);
  const items = Object.values(menu.itemsByCategory).flat();

  if (!items.length) return sendText(phone, '📭 No items in menu yet.', env);

  const rows = items.slice(0, 10).map(i => ({
    id:    `edit_${i.id}`,
    title: i.name,
    description: `$${i.price.toFixed(2)}`,
  }));

  session.state = 'admin_edit_item_select';
  await saveSession(phone, session, env);

  return sendList(phone, '✏️ *Edit Item*\nSelect item to edit:', 'Choose', [{ title: 'Items', rows }], env);
}

async function handleEditItemSelect(phone, msg, session, env) {
  if (!msg.id?.startsWith('edit_')) return startEditFlow(phone, session, env);

  const itemId = parseInt(msg.id.replace('edit_', ''), 10);
  const item   = await getMenuItem(itemId, env);
  if (!item) return sendText(phone, '⚠️ Item not found.', env);

  session.adminCtx.editItemId = itemId;
  session.state = 'admin_edit_item_field';
  await saveSession(phone, session, env);

  return sendList(
    phone,
    `✏️ Editing *${item.name}*\nCurrent price: $${item.price.toFixed(2)}\n\nWhich field to update?`,
    'Edit Field',
    [{
      title: 'Fields',
      rows: [
        { id: 'ef_name',        title: 'Name',        description: `Current: ${item.name}`                 },
        { id: 'ef_price',       title: 'Price',       description: `Current: $${item.price.toFixed(2)}`   },
        { id: 'ef_description', title: 'Description', description: `Current: ${(item.description||'').slice(0,40)}` },
        { id: 'ef_image_url',   title: 'Image URL',   description: `Current: ${item.image_url||'none'}`   },
      ],
    }],
    env
  );
}

async function handleEditItemField(phone, msg, session, env) {
  const fieldMap = {
    ef_name:        'name',
    ef_price:       'price',
    ef_description: 'description',
    ef_image_url:   'image_url',
  };
  const field = fieldMap[msg.id];
  if (!field) return startEditFlow(phone, session, env);

  session.adminCtx.editField = field;
  session.state = 'admin_edit_item_value';
  await saveSession(phone, session, env);

  const prompts = {
    name:        'Enter the new *name*:',
    price:       'Enter the new *price* (e.g. 12.99):',
    description: 'Enter the new *description*:',
    image_url:   'Enter the new *image URL*:',
  };
  return sendText(phone, prompts[field], env);
}

async function handleEditItemValue(phone, msg, session, env) {
  const { editItemId, editField } = session.adminCtx;

  // Guard against corrupted/replayed session
  if (!editItemId || !editField) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ Session lost. Please start over.', env);
  }

  let value = sanitize(msg.text || '', 500);

  if (editField === 'price') {
    const p = parseFloat(value);
    if (isNaN(p) || p < 0) return sendText(phone, '⚠️ Enter a valid price.', env);
    value = p;
  }

  await updateMenuItem(editItemId, { [editField]: value }, env);
  await bustMenuCache(env);

  session.state    = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `✅ Item updated! *${editField}* → ${value}`,
    [{ id: 'admin_home', title: '🔧 Admin Menu' }],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// Delete Item
// ─────────────────────────────────────────────────────────────

async function startDeleteFlow(phone, session, env) {
  const menu  = await getFullMenu(env);
  const items = Object.values(menu.itemsByCategory).flat();

  if (!items.length) return sendText(phone, '📭 No items to delete.', env);

  const rows = items.slice(0, 10).map(i => ({
    id:    `del_${i.id}`,
    title: i.name,
    description: `$${i.price.toFixed(2)}`,
  }));

  session.state = 'admin_delete_item_select';
  await saveSession(phone, session, env);

  return sendList(phone, '🗑️ *Delete Item*\nSelect item to delete:', 'Choose', [{ title: 'Items', rows }], env);
}

async function handleDeleteItemSelect(phone, msg, session, env) {
  if (!msg.id?.startsWith('del_')) return startDeleteFlow(phone, session, env);

  const itemId = parseInt(msg.id.replace('del_', ''), 10);
  const item   = await getMenuItem(itemId, env);
  if (!item) return sendText(phone, '⚠️ Item not found.', env);

  session.adminCtx.deleteItemId = itemId;
  session.adminCtx.deleteItemName = item.name;
  session.state = 'admin_delete_item_confirm';
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `⚠️ Delete *${item.name}* ($${item.price.toFixed(2)})?\n\nThis cannot be undone.`,
    [
      { id: 'confirm_delete', title: '🗑️ Yes, Delete' },
      { id: 'admin_home',     title: '❌ Cancel'       },
    ],
    env
  );
}

async function handleDeleteItemConfirm(phone, msg, session, env) {
  if (msg.id === 'confirm_delete') {
    await deleteMenuItem(session.adminCtx.deleteItemId, env);
    await bustMenuCache(env);
    const name = session.adminCtx.deleteItemName;
    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `✅ *${name}* deleted from menu.`,
      [{ id: 'admin_home', title: '🔧 Admin Menu' }],
      env
    );
  }
  session.state = 'admin_idle';
  await saveSession(phone, session, env);
  return showAdminMenu(phone, env);
}

// ─────────────────────────────────────────────────────────────
// Toggle availability
// ─────────────────────────────────────────────────────────────

async function startToggleFlow(phone, session, env) {
  // Query ALL items (not just available) — no need for getFullMenu here
  const allItems = await env.DB.prepare(
    'SELECT id, name, is_available FROM MenuItems ORDER BY name'
  ).all();

  if (!allItems.results.length) {
    return sendText(phone, '📭 No items in menu yet.', env);
  }

  const rows = allItems.results.slice(0, 10).map(i => ({
    id:          `tog_${i.id}`,
    title:       i.name,
    description: i.is_available ? '✅ Available' : '❌ Unavailable',
  }));

  session.state = 'admin_toggle_item_select';
  await saveSession(phone, session, env);

  return sendList(
    phone,
    '🔄 *Toggle Availability*\nSelect an item to flip its status:',
    'Choose Item',
    [{ title: 'All Items', rows }],
    env
  );
}

async function handleToggleItemSelect(phone, msg, session, env) {
  if (!msg.id?.startsWith('tog_')) {
    return startToggleFlow(phone, session, env);
  }

  const itemId = parseInt(msg.id.replace('tog_', ''), 10);
  const item   = await env.DB.prepare(
    'SELECT id, name, is_available FROM MenuItems WHERE id = ?'
  ).bind(itemId).first();

  if (!item) {
    return sendText(phone, '⚠️ Item not found.', env);
  }

  const newAvail = item.is_available ? 0 : 1;
  await env.DB.prepare(
    'UPDATE MenuItems SET is_available = ? WHERE id = ?'
  ).bind(newAvail, itemId).run();

  await bustMenuCache(env);

  session.state    = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  const label = newAvail ? '✅ Available' : '❌ Unavailable';
  return sendButtons(
    phone,
    `*${item.name}* is now marked *${label}*.`,
    [{ id: 'admin_home', title: '🔧 Admin Menu' }],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// View Orders
// ─────────────────────────────────────────────────────────────

async function viewOrders(phone, session, env) {
  const orders = await getPendingOrders(env);

  if (!orders.length) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendText(phone, '📭 No pending orders right now.', env);
  }

  const statusEmoji = {
    pending: '⏳', confirmed: '✅', preparing: '👨‍🍳',
  };

  // WhatsApp button message body cap: 1024 chars.
  // Build lines and truncate so we never exceed it.
  const lines = orders.map(
    o =>
      `• #${o.id} ${statusEmoji[o.status] || ''} ${o.status.toUpperCase()}` +
      ` $${Number(o.total_price).toFixed(2)}\n` +
      `  📱 ${o.user_phone}  📍 ${(o.address || '').slice(0, 30)}`
  );

  const header = `📦 *Active Orders* (${orders.length})\n\n`;
  let body = header;
  for (const line of lines) {
    if ((body + line).length > 950) {   // 950 gives buffer for WhatsApp overhead
      body += `\n_...and ${orders.length - lines.indexOf(line)} more_`;
      break;
    }
    body += line + '\n\n';
  }

  session.state = 'admin_orders_list';
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    body.trim(),
    [
      { id: 'admin_update_status', title: '✏️ Update Status' },
      { id: 'admin_home',          title: '🔧 Admin Menu'   },
    ],
    env
  );
}

async function handleAdminOrdersList(phone, msg, session, env) {
  if (msg.id === 'admin_update_status') {
    session.state = 'admin_update_status_id';
    await saveSession(phone, session, env);
    return sendText(phone, '📦 Enter the *Order ID* to update:', env);
  }
  session.state = 'admin_idle';
  await saveSession(phone, session, env);
  return showAdminMenu(phone, env);
}

// ─────────────────────────────────────────────────────────────
// Update Order Status
// ─────────────────────────────────────────────────────────────

async function handleUpdateStatusId(phone, msg, session, env) {
  const orderId = parseInt(msg.text || '', 10);
  if (isNaN(orderId)) return sendText(phone, '⚠️ Enter a valid order ID number.', env);

  const order = await getOrder(orderId, env);
  if (!order) return sendText(phone, `⚠️ Order #${orderId} not found.`, env);

  session.adminCtx.updateOrderId = orderId;
  session.adminCtx.orderPhone    = order.user_phone;
  session.state = 'admin_update_status_value';
  await saveSession(phone, session, env);

  const rows = VALID_STATUSES.map(s => ({ id: `status_${s}`, title: s.toUpperCase() }));
  return sendList(
    phone,
    `📦 Order #${orderId} — Current status: *${order.status.toUpperCase()}*\n\nSelect new status:`,
    'Choose Status',
    [{ title: 'Order Statuses', rows }],
    env
  );
}

async function handleUpdateStatusValue(phone, msg, session, env) {
  if (!msg.id?.startsWith('status_')) {
    return sendText(phone, '⚠️ Please select a status from the list.', env);
  }

  const newStatus = msg.id.replace('status_', '');

  // Whitelist check — never trust user-supplied IDs for DB writes
  if (!VALID_STATUSES.includes(newStatus)) {
    return sendText(phone, '⚠️ Invalid status selected.', env);
  }

  const { updateOrderId, orderPhone } = session.adminCtx;

  // Guard against missing context
  if (!updateOrderId || !orderPhone) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ Session lost. Please start over.', env);
  }

  await updateOrderStatus(updateOrderId, newStatus, env);

  // Notify customer — best effort, never throw
  const customerMsg = statusMessage(updateOrderId, newStatus);
  await sendText(orderPhone, customerMsg, env).catch(err =>
    console.error('[Admin] Failed to notify customer:', err)
  );

  session.state    = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `✅ Order #${updateOrderId} updated to *${newStatus.toUpperCase()}*.\nCustomer notified.`,
    [{ id: 'admin_home', title: '🔧 Admin Menu' }],
    env
  );
}

function statusMessage(orderId, status) {
  const messages = {
    confirmed:  `✅ Your Order #${orderId} has been *confirmed*! We're getting it ready.`,
    preparing:  `👨‍🍳 Your Order #${orderId} is now being *prepared*!`,
    ready:      `📦 Your Order #${orderId} is *ready* and on its way!`,
    delivered:  `🎉 Your Order #${orderId} has been *delivered*! Enjoy your meal!`,
    cancelled:  `❌ Your Order #${orderId} has been *cancelled*. Contact us for help.`,
  };
  return messages[status] || `📦 Your Order #${orderId} status: *${status.toUpperCase()}*`;
}
