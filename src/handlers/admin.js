/**
 * src/handlers/admin.js — Admin Command State Machine
 *
 * BUG-04 FIX: Edit, delete, and toggle flows now use getAllMenuItems()
 *             which returns ALL items regardless of availability, so
 *             unavailable items are still manageable by admins.
 *
 * BUG-05 FIX: Guards added to handleAddItemPrice, handleAddItemDescription,
 *             handleAddItemImage to prevent TypeError on corrupted sessions.
 *
 * BUG-09 FIX: viewOrders truncation uses loop index (i), not indexOf(),
 *             which returned the wrong count when lines were textually identical.
 *
 * BUG-10 FIX: Image URL validated as HTTPS before being stored.
 *
 * BUG-12 FIX: Order ID parsing uses a strict /^\d+$/ regex check so
 *             "5abc" cannot silently be accepted as order 5.
 *
 * BUG-20 FIX: handleAddCategory inspects error message to differentiate
 *             a UNIQUE constraint violation from a D1 connectivity error.
 *
 * BUG-21:     Lists hard-cap at 10 rows; a "showing X of N" note is added
 *             when items are truncated so admins know more exist.
 *
 * States:
 *   admin_idle | admin_add_category
 *   admin_add_item_{name,category,price,description,image}
 *   admin_edit_item_{select,field,value}
 *   admin_delete_item_{select,confirm}
 *   admin_toggle_item_select
 *   admin_orders_list | admin_update_status_{id,value}
 */

import {
  sendText, sendButtons, sendList,
} from '../whatsapp.js';
import {
  getSession, saveSession, bustMenuCache, formatPrice, MAX_PRICE, CURRENCY_SYMBOL,
} from '../session.js';
import {
  getAllMenuItems, getMenuItem, getCategories,
  createMenuItem, updateMenuItem, deleteMenuItem,
  getPendingOrders, getOrder, updateOrderStatus,
  bulkUpdateOrderStatus, bulkUpdateMenuAvailability,
  getMenuItemsPaginated, getActiveOrdersPaginated,
  logBulkAction,
} from '../db.js';
import { sanitize, isValidHttpsUrl } from '../security.js';

const VALID_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'];

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export async function handleAdminMessage(phone, msg, env) {
  const session = await getSession(phone, env);

  // Ensure adminCtx always exists — old sessions may predate this field
  session.adminCtx = session.adminCtx || {};

  const text = (msg.text || '').toUpperCase().trim();

  // CANCEL command: abort any flow and return to admin menu
  if (text === 'CANCEL' || msg.id === 'admin_cancel') {
    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '❌ Action cancelled.',
      [{ id: 'admin_home', title: '🔧 Admin Menu' }],
      env
    );
  }

  // "ADMIN" or the admin_home button always resets to the admin menu
  if (text === 'ADMIN' || msg.id === 'admin_home') {
    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return showAdminMenu(phone, env);
  }

  // BACK command: go back one step in multi-step flows
  if (text === 'BACK' || msg.id === 'admin_back') {
    return handleBackNavigation(phone, session, env);
  }

  switch (session.state) {
    case 'admin_idle':                return handleAdminIdle(phone, msg, session, env);
    case 'admin_add_category':        return handleAddCategory(phone, msg, session, env);
    case 'admin_add_item_name':       return handleAddItemName(phone, msg, session, env);
    case 'admin_add_item_category':   return handleAddItemCategory(phone, msg, session, env);
    case 'admin_add_item_price':      return handleAddItemPrice(phone, msg, session, env);
    case 'admin_add_item_description':return handleAddItemDescription(phone, msg, session, env);
    case 'admin_add_item_image':      return handleAddItemImage(phone, msg, session, env);
    case 'admin_edit_item_select':    return handleEditItemSelect(phone, msg, session, env);
    case 'admin_edit_item_field':     return handleEditItemField(phone, msg, session, env);
    case 'admin_edit_item_value':     return handleEditItemValue(phone, msg, session, env);
    case 'admin_delete_item_select':  return handleDeleteItemSelect(phone, msg, session, env);
    case 'admin_delete_item_confirm': return handleDeleteItemConfirm(phone, msg, session, env);
    case 'admin_toggle_item_select':  return handleToggleItemSelect(phone, msg, session, env);
    case 'admin_orders_list':         return handleAdminOrdersList(phone, msg, session, env);
    case 'admin_update_status_id':    return handleUpdateStatusId(phone, msg, session, env);
    case 'admin_update_status_value': return handleUpdateStatusValue(phone, msg, session, env);
    case 'admin_update_status_confirm': return handleUpdateStatusConfirm(phone, msg, session, env);
    
    // Bulk Actions
    case 'admin_bulk_menu':           return handleBulkMenu(phone, msg, session, env);
    case 'admin_bulk_orders_action':  return handleBulkOrdersAction(phone, msg, session, env);
    case 'admin_bulk_orders_select':  return handleBulkOrdersSelect(phone, msg, session, env);
    case 'admin_bulk_orders_confirm': return handleBulkOrdersConfirm(phone, msg, session, env);
    case 'admin_bulk_items_action':   return handleBulkItemsAction(phone, msg, session, env);
    case 'admin_bulk_items_select':   return handleBulkItemsSelect(phone, msg, session, env);
    case 'admin_bulk_items_confirm':  return handleBulkItemsConfirm(phone, msg, session, env);

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
          { id: 'admin_add_item',    title: 'Add Item',      description: 'Add a new menu item'          },
          { id: 'admin_edit_item',   title: 'Edit Item',     description: 'Update price, name, etc.'     },
          { id: 'admin_delete_item', title: 'Delete Item',   description: 'Remove item from menu'        },
          { id: 'admin_add_cat',     title: 'Add Category',  description: 'Create a new menu category'   },
          { id: 'admin_toggle_item', title: 'Toggle Avail.', description: 'Mark item available/unavail.' },
        ],
      },
      {
        title: 'Operations',
        rows: [
          { id: 'admin_view_orders',   title: 'View Orders',   description: 'See pending/active orders' },
          { id: 'admin_update_status', title: 'Update Status', description: 'Change an order status'    },
          { id: 'admin_bulk_menu',     title: 'Bulk Actions',  description: 'Manage multiple items/orders' },
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
  if (id === 'admin_add_another_cat') {
    session.state = 'admin_add_category';
    await saveSession(phone, session, env);
    return sendText(phone, '📂 Enter the new *category name*:', env);
  }
  if (id === 'admin_edit_item')   return startEditFlow(phone, session, env);
  if (id === 'admin_delete_item') return startDeleteFlow(phone, session, env);
  if (id === 'admin_toggle_item') return startToggleFlow(phone, session, env);
  if (id === 'admin_view_orders') return viewOrders(phone, session, env);
  if (id === 'admin_update_status') {
    session.state = 'admin_update_status_id';
    await saveSession(phone, session, env);
    return sendText(phone, '📦 Enter the *Order ID* to update:', env);
  }
  if (id === 'admin_bulk_menu') {
    return showBulkMenu(phone, session, env);
  }

  return showAdminMenu(phone, env);
}

// ─────────────────────────────────────────────────────────────
// Back Navigation Handler
// ─────────────────────────────────────────────────────────────

async function handleBackNavigation(phone, session, env) {
  const { state, adminCtx } = session;

  // Map current state to previous state
  const backMap = {
    'admin_add_item_category':   { newState: 'admin_add_item_name', prompt: '➕ *Add New Item*\n\nEnter the item *name*:' },
    'admin_add_item_price':      { newState: 'admin_add_item_category', prompt: null }, // Will re-show category list
    'admin_add_item_description':{ newState: 'admin_add_item_price', prompt: '💰 Enter the *price* (e.g. 9.99):' },
    'admin_add_item_image':      { newState: 'admin_add_item_description', prompt: null }, // Will re-show description prompt
    'admin_edit_item_field':     { newState: 'admin_edit_item_select', prompt: null }, // Will re-show item list
    'admin_edit_item_value':     { newState: 'admin_edit_item_field', prompt: null }, // Will re-show field list
    'admin_update_status_value': { newState: 'admin_orders_list', prompt: null }, // Will re-show order list
    'admin_update_status_confirm': { newState: 'admin_update_status_value', prompt: null }, // Will re-show status list
  };

  const backInfo = backMap[state];
  if (!backInfo) {
    // Can't go back from here, stay in current state
    return sendText(
      phone,
      '⚠️ Cannot go back from here.\n\nSend *CANCEL* to abort or continue.',
      env
    );
  }

  session.state = backInfo.newState;
  await saveSession(phone, session, env);

  // Special handling for states that show lists
  if (state === 'admin_add_item_price') {
    const cats = await getCategories(env);
    const rows = cats.map(c => ({ id: `acat_${c.id}`, title: c.name }));
    return sendList(
      phone,
      `📂 Choose a *category* for "${adminCtx?.newItem?.name || 'this item'}":`,
      'Select Category',
      [{ title: 'Categories', rows }],
      env
    );
  }

  if (state === 'admin_add_item_image') {
    return sendButtons(
      phone,
      '📝 Enter a *description* for this item:\n\n' +
      'Tap *Skip* if no description needed.',
      [{ id: 'skip_desc', title: 'Skip' }],
      env
    );
  }

  if (state === 'admin_update_status_value' || state === 'admin_update_status_confirm') {
    return viewOrders(phone, session, env);
  }

  return sendText(phone, backInfo.prompt + '\n\nSend *CANCEL* to abort.', env);
}

// ─────────────────────────────────────────────────────────────
// Add Category
// ─────────────────────────────────────────────────────────────

async function handleAddCategory(phone, msg, session, env) {
  const name = sanitize(msg.text || '', 50);
  if (name.length < 2) {
    return sendText(
      phone,
      '⚠️ Category name must be at least 2 characters.\n\n' +
      'Send *CANCEL* to abort.',
      env
    );
  }

  try {
    const result = await env.DB.prepare(
      'INSERT INTO MenuCategories (name) VALUES (?)'
    ).bind(name).run();
    console.log('[Admin] Category created:', name, 'meta:', result.meta);
    await bustMenuCache(env);
    // Keep state as admin_add_category to allow adding multiple categories
    const response = await sendButtons(
      phone,
      `✅ Category *${name}* created!`,
      [
        { id: 'admin_add_another_cat', title: '➕ Add Another Category' },
        { id: 'admin_home', title: '🔧 Admin Menu' },
      ],
      env
    );
    console.log('[Admin] Confirmation sent for category:', name);
    return response;
  } catch (err) {
    // BUG-20 FIX: Inspect error to distinguish duplicate-name from DB failure
    const msg2 = err?.message || '';
    if (msg2.includes('UNIQUE') || msg2.includes('unique')) {
      return sendText(phone, `⚠️ Category *${name}* already exists. Choose a different name.`, env);
    }
    console.error('[Admin] createCategory DB error:', err);
    return sendText(phone, '⚠️ Failed to create category. Please try again.', env);
  }
}

// ─────────────────────────────────────────────────────────────
// Add Item — multi-step flow
// ─────────────────────────────────────────────────────────────

async function handleAddItemName(phone, msg, session, env) {
  const name = sanitize(msg.text || '', 100);
  if (name.length < 2) {
    return sendText(
      phone,
      '⚠️ Name must be at least 2 characters.\n\n' +
      'Examples: "Classic Burger", "Caesar Salad"\n' +
      'Send *CANCEL* to abort.',
      env
    );
  }

  // Check for duplicate item name
  const existing = await env.DB.prepare(
    'SELECT id FROM MenuItems WHERE LOWER(name) = LOWER(?)'
  ).bind(name).first();
  if (existing) {
    return sendText(
      phone,
      `⚠️ An item named "${name}" already exists.\n\n` +
      'Please use a different name or edit the existing item.\n' +
      'Send *CANCEL* to abort.',
      env
    );
  }

  session.adminCtx.newItem = { name };
  session.state = 'admin_add_item_category';
  await saveSession(phone, session, env);

  const cats = await getCategories(env);
  if (!cats.length) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ No categories exist yet. Create one first via Add Category.', env);
  }

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
  // BUG-05 FIX: guard corrupted session
  if (!session.adminCtx?.newItem) {
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
  // BUG-05 FIX: guard corrupted session
  if (!session.adminCtx?.newItem) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ Session lost. Please start over.', env);
  }
  const price = parseFloat(msg.text || '');
  if (isNaN(price) || price < 0) {
    return sendText(
      phone,
      '⚠️ Enter a valid price (e.g. 9.99).\n\n' +
      'Price must be a positive number.\n' +
      'Send *CANCEL* to abort or *BACK* to change the name.',
      env
    );
  }
  if (price > MAX_PRICE) {
    return sendText(
      phone,
      `⚠️ Price seems too high (₦${price}).\n\n` +
      `Maximum allowed is ₦${MAX_PRICE}.\n` +
      'Send *CANCEL* to abort or *BACK* to change the name.',
      env
    );
  }
  session.adminCtx.newItem.price = price;
  session.state = 'admin_add_item_description';
  await saveSession(phone, session, env);
  return sendButtons(
    phone,
    '📝 Enter a *description* for this item:\n\n' +
    'Send *BACK* to change the price.',
    [{ id: 'skip_desc', title: 'Skip' }],
    env
  );
}

async function handleAddItemDescription(phone, msg, session, env) {
  // BUG-05 FIX: guard corrupted session
  if (!session.adminCtx?.newItem) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ Session lost. Please start over.', env);
  }
  const desc = msg.id === 'skip_desc' ? '' : sanitize(msg.text || '', 300);
  session.adminCtx.newItem.description = desc;
  session.state = 'admin_add_item_image';
  await saveSession(phone, session, env);
  return sendButtons(
    phone,
    '🖼️ Enter an *image URL* (must be https://) or skip:\n\n' +
    'Send *BACK* to change the description.',
    [{ id: 'skip_img', title: 'Skip' }],
    env
  );
}

async function handleAddItemImage(phone, msg, session, env) {
  // BUG-05 FIX: guard corrupted session
  if (!session.adminCtx?.newItem) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ Session lost. Please start over.', env);
  }

  // Handle BACK navigation
  if (msg.text?.toUpperCase().trim() === 'BACK') {
    session.state = 'admin_add_item_description';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '📝 Enter a *description* for this item:\n\n' +
      'Tap *Skip* if no description needed.',
      [{ id: 'skip_desc', title: 'Skip' }],
      env
    );
  }

  let imageUrl = '';
  if (msg.id !== 'skip_img') {
    const raw = sanitize(msg.text || '', 500);
    // BUG-10 FIX: validate HTTPS before storing
    if (!isValidHttpsUrl(raw)) {
      return sendText(
        phone,
        '⚠️ Image URL must start with *https://*\n\n' +
        'Please enter a valid URL, tap *Skip*, or send *BACK*.',
        env
      );
    }
    imageUrl = raw;
  }

  const item = session.adminCtx.newItem;
  item.imageUrl = imageUrl;

  const id = await createMenuItem(item, env);
  await bustMenuCache(env);

  session.state    = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `✅ *${item.name}* added to menu! (ID: ${id})\n💰 ₦${item.price.toFixed(2)}`,
    [{ id: 'admin_home', title: '🔧 Admin Menu' }],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// Edit Item
// ─────────────────────────────────────────────────────────────

async function startEditFlow(phone, session, env) {
  // BUG-04 FIX: use getAllMenuItems so unavailable items are still editable
  const items = await getAllMenuItems(env);

  if (!items.length) {
    return sendText(phone, '📭 No items in menu yet.', env);
  }

  // BUG-21: show count when truncated
  const visible = items.slice(0, 10);
  const rows = visible.map(i => ({
    id:          `edit_${i.id}`,
    title:       i.name,
    description: `₦${i.price.toFixed(2)}${i.is_available ? '' : ' (unavail)'}`,
  }));

  const footer = items.length > 10
    ? `Showing 10 of ${items.length} items`
    : null;

  session.state = 'admin_edit_item_select';
  await saveSession(phone, session, env);

  return sendList(
    phone,
    `✏️ *Edit Item*\nSelect an item to edit:${footer ? `\n_${footer}_` : ''}`,
    'Choose',
    [{ title: 'Items', rows }],
    env
  );
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
    `✏️ Editing *${item.name}* (₦${item.price.toFixed(2)})\nWhich field to update?`,
    'Edit Field',
    [{
      title: 'Fields',
      rows: [
        { id: 'ef_name',        title: 'Name',        description: `Current: ${item.name}` },
        { id: 'ef_price',       title: 'Price',       description: `Current: ₦${item.price.toFixed(2)}` },
        { id: 'ef_description', title: 'Description', description: `Current: ${(item.description || '').slice(0, 40)}` },
        { id: 'ef_image_url',   title: 'Image URL',   description: `Current: ${item.image_url || 'none'}` },
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
  if (!field) {
    // User typed text instead of selecting from list - show helpful message
    return sendText(
      phone,
      '⚠️ Please tap a button above to choose which field to edit.\n\n' +
      'Send *CANCEL* to abort.',
      env
    );
  }

  session.adminCtx.editField = field;
  session.state = 'admin_edit_item_value';
  await saveSession(phone, session, env);

  const prompts = {
    name:        'Enter the new *name*:',
    price:       'Enter the new *price* (e.g. 12.99):',
    description: 'Enter the new *description*:',
    image_url:   'Enter the new *image URL* (must be https://):',
  };
  return sendText(phone, prompts[field], env);
}

async function handleEditItemValue(phone, msg, session, env) {
  const { editItemId, editField } = session.adminCtx;

  if (!editItemId || !editField) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ Session lost. Please start over.', env);
  }

  // Handle CANCEL
  const text = (msg.text || '').toUpperCase().trim();
  if (text === 'CANCEL') {
    session.state = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '❌ Edit cancelled.',
      [{ id: 'admin_home', title: '🔧 Admin Menu' }],
      env
    );
  }

  let value = sanitize(msg.text || '', 500);

  if (editField === 'price') {
    const p = parseFloat(value);
    if (isNaN(p) || p < 0) {
      return sendText(
        phone,
        '⚠️ Enter a valid price (e.g. 12.99).\n\n' +
        'Send *CANCEL* to abort.',
        env
      );
    }
    if (p > MAX_PRICE) {
      return sendText(
        phone,
        `⚠️ Price seems too high. Maximum is ₦${MAX_PRICE}.\n\n` +
        'Send *CANCEL* to abort.',
        env
      );
    }
    value = p;
  }

  // BUG-10 FIX: validate HTTPS on image URL edits
  if (editField === 'image_url' && value && !isValidHttpsUrl(value)) {
    return sendText(
      phone,
      '⚠️ Image URL must start with *https://*.\n\n' +
      'Send *CANCEL* to abort.',
      env
    );
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
  // BUG-04 FIX: use getAllMenuItems so unavailable items can still be deleted
  const items = await getAllMenuItems(env);

  if (!items.length) {
    return sendText(phone, '📭 No items to delete.', env);
  }

  // BUG-21: show count when truncated
  const visible = items.slice(0, 10);
  const rows = visible.map(i => ({
    id:          `del_${i.id}`,
    title:       i.name,
    description: `₦${i.price.toFixed(2)}${i.is_available ? '' : ' (unavail)'}`,
  }));

  const footer = items.length > 10
    ? `Showing 10 of ${items.length} items`
    : null;

  session.state = 'admin_delete_item_select';
  await saveSession(phone, session, env);

  return sendList(
    phone,
    `🗑️ *Delete Item*\nSelect item to delete:${footer ? `\n_${footer}_` : ''}`,
    'Choose',
    [{ title: 'Items', rows }],
    env
  );
}

async function handleDeleteItemSelect(phone, msg, session, env) {
  if (!msg.id?.startsWith('del_')) return startDeleteFlow(phone, session, env);

  const itemId = parseInt(msg.id.replace('del_', ''), 10);
  const item   = await getMenuItem(itemId, env);
  if (!item) return sendText(phone, '⚠️ Item not found.', env);

  session.adminCtx.deleteItemId   = itemId;
  session.adminCtx.deleteItemName = item.name;
  session.state = 'admin_delete_item_confirm';
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `⚠️ Delete *${item.name}* (₦${item.price.toFixed(2)})?\n\nThis cannot be undone.`,
    [
      { id: 'confirm_delete', title: '🗑️ Yes, Delete' },
      { id: 'admin_home',     title: '❌ Cancel'       },
    ],
    env
  );
}

async function handleDeleteItemConfirm(phone, msg, session, env) {
  if (msg.id === 'confirm_delete') {
    const { deleteItemId, deleteItemName } = session.adminCtx;
    if (!deleteItemId) {
      session.state = 'admin_idle';
      await saveSession(phone, session, env);
      return sendText(phone, '⚠️ Session lost. Please start over.', env);
    }

    await deleteMenuItem(deleteItemId, env);
    await bustMenuCache(env);

    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);

    return sendButtons(
      phone,
      `✅ *${deleteItemName}* deleted from menu.`,
      [{ id: 'admin_home', title: '🔧 Admin Menu' }],
      env
    );
  }

  session.state = 'admin_idle';
  await saveSession(phone, session, env);
  return showAdminMenu(phone, env);
}

// ─────────────────────────────────────────────────────────────
// Toggle Availability
// ─────────────────────────────────────────────────────────────

async function startToggleFlow(phone, session, env) {
  // BUG-04 FIX: getAllMenuItems — must see unavailable items to re-enable them
  const items = await getAllMenuItems(env);

  if (!items.length) {
    return sendText(phone, '📭 No items in menu yet.', env);
  }

  const visible = items.slice(0, 10);
  const rows = visible.map(i => ({
    id:          `tog_${i.id}`,
    title:       i.name,
    description: i.is_available ? '✅ Available' : '❌ Unavailable',
  }));

  const footer = items.length > 10
    ? `Showing 10 of ${items.length} items`
    : null;

  session.state = 'admin_toggle_item_select';
  await saveSession(phone, session, env);

  return sendList(
    phone,
    `🔄 *Toggle Availability*\nTap an item to flip its status:${footer ? `\n_${footer}_` : ''}`,
    'Choose Item',
    [{ title: 'All Items', rows }],
    env
  );
}

async function handleToggleItemSelect(phone, msg, session, env) {
  if (!msg.id?.startsWith('tog_')) return startToggleFlow(phone, session, env);

  const itemId = parseInt(msg.id.replace('tog_', ''), 10);
  const item   = await env.DB.prepare(
    'SELECT id, name, is_available FROM MenuItems WHERE id = ?'
  ).bind(itemId).first();

  if (!item) return sendText(phone, '⚠️ Item not found.', env);

  const newAvail = item.is_available ? 0 : 1;
  await env.DB.prepare('UPDATE MenuItems SET is_available = ? WHERE id = ?')
    .bind(newAvail, itemId)
    .run();
  await bustMenuCache(env);

  session.state    = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  const label = newAvail ? '✅ Available' : '❌ Unavailable';
  return sendButtons(
    phone,
    `*${item.name}* is now *${label}*.`,
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

  const statusEmoji = { pending: '⏳', confirmed: '✅', preparing: '👨‍🍳' };

  const rows = orders.map(o => ({
    id: `astat_${o.id}`,
    title: `#${o.id} - ${o.status.toUpperCase()} (${formatPrice(o.total_price)})`,
    description: `� ${o.payment_status.toUpperCase()} | �� ${o.user_phone} | 📍 ${(o.address || '').slice(0, 20)}`
  }));

  session.state = 'admin_orders_list';
  await saveSession(phone, session, env);

  return sendList(
    phone,
    '📦 *Active Orders*\nSelect an order to update its status:',
    'Select Order',
    [{ title: 'Pending/Active', rows }],
    env
  );
}

async function handleAdminOrdersList(phone, msg, session, env) {
  if (msg.type === 'list_reply' && msg.id?.startsWith('astat_')) {
    const orderId = parseInt(msg.id.replace('astat_', ''), 10);
    const order = await getOrder(orderId, env);
    if (!order) return viewOrders(phone, session, env);

    session.adminCtx.updateOrderId = orderId;
    session.adminCtx.orderPhone    = order.user_phone;
    session.state = 'admin_update_status_value';
    await saveSession(phone, session, env);

    const rows = VALID_STATUSES.map(s => ({ id: `status_${s}`, title: s.toUpperCase() }));
    return sendList(
      phone,
      `📦 *Order #${orderId}* - Current: ${order.status.toUpperCase()}\n\nSelect new status:`,
      'Choose Status',
      [{ title: 'Order Statuses', rows }],
      env
    );
  }

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
  const raw = (msg.text || '').trim();
  const text = raw.toUpperCase();

  // Allow CANCEL to abort
  if (text === 'CANCEL') {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '❌ Status update cancelled.',
      [{ id: 'admin_home', title: '🔧 Admin Menu' }],
      env
    );
  }

  // BUG-12 FIX: strict integer parse — parseInt('5abc') returns 5, which is wrong.
  // /^\d+$/ ensures only pure digit strings are accepted.
  if (!/^\d+$/.test(raw)) {
    return sendText(
      phone,
      '⚠️ Enter a valid order ID number (digits only).\n\n' +
      'Example: *42*\n' +
      'Send *CANCEL* to abort.',
      env
    );
  }
  const orderId = parseInt(raw, 10);
  if (orderId <= 0) {
    return sendText(
      phone,
      '⚠️ Order ID must be a positive number.\n\n' +
      'Send *CANCEL* to abort.',
      env
    );
  }

  const order = await getOrder(orderId, env);
  if (!order) {
    return sendText(phone, `⚠️ Order #${orderId} not found.`, env);
  }

  session.adminCtx.updateOrderId = orderId;
  session.adminCtx.orderPhone    = order.user_phone;
  session.state = 'admin_update_status_value';
  await saveSession(phone, session, env);

  const rows = VALID_STATUSES.map(s => ({ id: `status_${s}`, title: s.toUpperCase() }));
  return sendList(
    phone,
    `📦 Order #${orderId} — Current: *${order.status.toUpperCase()}*\n\nSelect new status:`,
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
  if (!VALID_STATUSES.includes(newStatus)) {
    return sendText(phone, '⚠️ Invalid status.', env);
  }

  session.adminCtx.newStatus = newStatus;
  
  // Ask for confirmation for destructive or final statuses
  if (newStatus === 'cancelled' || newStatus === 'delivered') {
    session.state = 'admin_update_status_confirm';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `⚠️ *Confirm Status Change*\n\nAre you sure you want to mark order #${session.adminCtx.updateOrderId} as *${newStatus.toUpperCase()}*?`,
      [
        { id: 'confirm_status_yes', title: 'Yes, Confirm' },
        { id: 'admin_back',         title: '⬅️ Back'        },
      ],
      env
    );
  }

  return performStatusUpdate(phone, session, env);
}

async function handleUpdateStatusConfirm(phone, msg, session, env) {
  if (msg.id === 'confirm_status_yes') {
    return performStatusUpdate(phone, session, env);
  }
  
  // Any other input or cancel handled by global interceptors
  return viewOrders(phone, session, env);
}

async function performStatusUpdate(phone, session, env) {
  const { updateOrderId, orderPhone, newStatus } = session.adminCtx;
  if (!updateOrderId || !orderPhone || !newStatus) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendText(phone, '⚠️ Session lost. Please start over.', env);
  }

  await updateOrderStatus(updateOrderId, newStatus, env);

  // Notify customer — best effort
  const customerMsg = statusMessage(updateOrderId, newStatus);
  await sendText(orderPhone, customerMsg, env)
    .catch(err => console.error('[Admin] Failed to notify customer:', err));

  session.state    = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `✅ Order #${updateOrderId} → *${newStatus.toUpperCase()}*.\nCustomer notified.`,
    [{ id: 'admin_home', title: '🔧 Admin Menu' }],
    env
  );
}

function statusMessage(orderId, status) {
  const messages = {
    confirmed: `✅ Order #${orderId} *confirmed*! We're getting it ready.`,
    preparing: `👨‍🍳 Order #${orderId} is being *prepared*!`,
    ready:     `📦 Order #${orderId} is *ready* and on its way!`,
    delivered: `🎉 Order #${orderId} *delivered*! Enjoy your meal!`,
    cancelled: `❌ Order #${orderId} *cancelled*. Contact us if you have questions.`,
  };
  return messages[status] || `📦 Order #${orderId} status: *${status.toUpperCase()}*`;
}

// ─────────────────────────────────────────────────────────────
// Bulk Actions — Multi-step paginated flow
// ─────────────────────────────────────────────────────────────

async function showBulkMenu(phone, session, env) {
  session.state = 'admin_bulk_menu';
  session.adminCtx.bulk = {}; // Clear context
  await saveSession(phone, session, env);

  return sendList(
    phone,
    '🏗️ *Bulk Actions*\nChoose a domain to manage in bulk:',
    'Choose Domain',
    [{
      title: 'Bulk Domains',
      rows: [
        { id: 'bulk_orders', title: 'Bulk Orders', description: 'Update status of multiple orders' },
        { id: 'bulk_items',  title: 'Bulk Menu',   description: 'Toggle availability of multiple items' },
      ]
    }],
    env
  );
}

async function handleBulkMenu(phone, msg, session, env) {
  if (msg.id === 'bulk_orders') {
    session.state = 'admin_bulk_orders_action';
    session.adminCtx.bulk = { type: 'orders', selectedIds: [], page: 0 };
    await saveSession(phone, session, env);

    const rows = VALID_STATUSES.map(s => ({ id: `ba_os_${s}`, title: s.toUpperCase() }));
    return sendList(
      phone,
      '📦 *Bulk Orders*\nWhich status do you want to apply to multiple orders?',
      'Choose Status',
      [{ title: 'Statuses', rows }],
      env
    );
  }

  if (msg.id === 'bulk_items') {
    session.state = 'admin_bulk_items_action';
    session.adminCtx.bulk = { type: 'menu_items', selectedIds: [], page: 0 };
    await saveSession(phone, session, env);

    return sendButtons(
      phone,
      '🍽️ *Bulk Menu*\nWhat do you want to do with multiple items?',
      [
        { id: 'ba_mi_avail', title: 'Mark Available' },
        { id: 'ba_mi_unavail', title: 'Mark Unavail.' },
        { id: 'admin_home', title: '❌ Cancel' }
      ],
      env
    );
  }

  return showBulkMenu(phone, session, env);
}

async function handleBulkOrdersAction(phone, msg, session, env) {
  if (!msg.id?.startsWith('ba_os_')) return handleBulkMenu(phone, { id: 'bulk_orders' }, session, env);

  const status = msg.id.replace('ba_os_', '');
  session.adminCtx.bulk.action = 'set_status';
  session.adminCtx.bulk.targetValue = status;
  session.state = 'admin_bulk_orders_select';
  await saveSession(phone, session, env);

  return showBulkOrdersList(phone, session, env);
}

async function showBulkOrdersList(phone, session, env) {
  const { bulk } = session.adminCtx;
  const pageSize = 8;
  const offset = bulk.page * pageSize;

  const { orders, total } = await getActiveOrdersPaginated(env, pageSize, offset);

  if (!orders.length && bulk.page === 0) {
    return sendText(phone, '📭 No active orders found to manage in bulk.', env);
  }

  const rows = orders.map(o => {
    const isSelected = bulk.selectedIds.includes(o.id);
    return {
      id: `bs_o_${o.id}`,
      title: `${isSelected ? '✅' : '⬜'} #${o.id} - ${o.status.toUpperCase()}`,
      description: `💳 ${o.payment_status.toUpperCase()} | ₦${o.total_price.toFixed(2)} | 📱 ${o.user_phone}`
    };
  });

  if (offset + pageSize < total) {
    rows.push({ id: 'bulk_page_next', title: '➡️ Next Page', description: `Show orders ${offset + pageSize + 1}-${Math.min(offset + pageSize * 2, total)}` });
  }
  if (bulk.page > 0) {
    rows.push({ id: 'bulk_page_prev', title: '⬅️ Prev Page', description: `Show orders ${offset - pageSize + 1}-${offset}` });
  }

  const footer = `Page ${bulk.page + 1} of ${Math.ceil(total / pageSize)} | ${bulk.selectedIds.length} selected`;

  return sendList(
    phone,
    `📦 *Select Orders* for bulk *${bulk.targetValue.toUpperCase()}*\n\nTap an order to select/deselect it.\n\n${footer}`,
    'Select Orders',
    [{ title: 'Active Orders', rows }],
    env
  );
}

async function handleBulkOrdersSelect(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id === 'bulk_page_next') {
    bulk.page++;
    await saveSession(phone, session, env);
    return showBulkOrdersList(phone, session, env);
  }
  if (msg.id === 'bulk_page_prev') {
    bulk.page = Math.max(0, bulk.page - 1);
    await saveSession(phone, session, env);
    return showBulkOrdersList(phone, session, env);
  }

  if (msg.id?.startsWith('bs_o_')) {
    const orderId = parseInt(msg.id.replace('bs_o_', ''), 10);
    const idx = bulk.selectedIds.indexOf(orderId);
    if (idx > -1) {
      bulk.selectedIds.splice(idx, 1);
    } else {
      bulk.selectedIds.push(orderId);
    }
    await saveSession(phone, session, env);
    return showBulkOrdersList(phone, session, env);
  }

  // Handle buttons
  if (msg.id === 'bulk_review' || (msg.text || '').toUpperCase() === 'REVIEW') {
    if (!bulk.selectedIds.length) {
      return sendText(phone, '⚠️ Please select at least one order first.', env);
    }

    session.state = 'admin_bulk_orders_confirm';
    await saveSession(phone, session, env);

    const isRisky = ['delivered', 'cancelled'].includes(bulk.targetValue);
    let body = `📝 *Bulk Review*\n\nAction: *${bulk.targetValue.toUpperCase()}*\nTarget: ${bulk.selectedIds.length} orders (#${bulk.selectedIds.join(', #')})\n\n`;
    
    if (bulk.targetValue === 'cancelled') {
      return sendText(phone, body + '❓ Why are these orders being cancelled?\n\n(Type the reason and send)', env);
    }

    return sendButtons(
      phone,
      body + `Notify customers?`,
      [
        { id: 'bulk_confirm_notify', title: '✅ Yes, Notify' },
        { id: 'bulk_confirm_silent', title: '🤫 No, Silent' },
        { id: 'admin_back', title: '⬅️ Back' }
      ],
      env
    );
  }

  if (msg.id === 'bulk_clear') {
    bulk.selectedIds = [];
    await saveSession(phone, session, env);
    return showBulkOrdersList(phone, session, env);
  }

  // Any other input — show the list again with help
  return sendButtons(
    phone,
    `Selected: ${bulk.selectedIds.length} orders.\nTap orders to select, then review.`,
    [
      { id: 'bulk_review', title: '✅ Review' },
      { id: 'bulk_clear',  title: '🧹 Clear'  },
      { id: 'admin_home',  title: '❌ Cancel' }
    ],
    env
  );
}

async function handleBulkOrdersConfirm(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  // Handle cancellation reason
  if (bulk.targetValue === 'cancelled' && !bulk.cancellationReason && msg.text) {
    bulk.cancellationReason = sanitize(msg.text, 200);
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `Action: *CANCEL*\nReason: ${bulk.cancellationReason}\nTarget: ${bulk.selectedIds.length} orders\n\nNotify customers?`,
      [
        { id: 'bulk_confirm_notify', title: '✅ Yes, Notify' },
        { id: 'bulk_confirm_silent', title: '🤫 No, Silent' },
        { id: 'admin_back', title: '⬅️ Back' }
      ],
      env
    );
  }

  if (msg.id === 'bulk_confirm_notify' || msg.id === 'bulk_confirm_silent') {
    bulk.notifyCustomers = (msg.id === 'bulk_confirm_notify');
    return executeBulkOrders(phone, session, env);
  }

  return showAdminMenu(phone, env);
}

async function executeBulkOrders(phone, session, env) {
  const { bulk } = session.adminCtx;
  const status = bulk.targetValue;
  
  let successCount = 0;
  let skippedCount = 0;
  let failureCount = 0;
  const failureDetails = [];

  for (const id of bulk.selectedIds) {
    try {
      const order = await getOrder(id, env);
      if (!order) {
        skippedCount++;
        continue;
      }

      // Decision #4: Unpaid Paystack orders excluded from kitchen statuses by default
      const isKitchenStatus = ['confirmed', 'preparing', 'ready'].includes(status);
      if (isKitchenStatus && order.payment_status !== 'paid') {
        skippedCount++;
        continue;
      }

      await updateOrderStatus(id, status, env);
      successCount++;

      if (bulk.notifyCustomers) {
        let msg = statusMessage(id, status);
        if (status === 'cancelled' && bulk.cancellationReason) {
          msg = `❌ Order #${id} cancelled.\nReason: ${bulk.cancellationReason}\n\nIf you already paid, our team will contact you about refund/support.`;
        }
        await sendText(order.user_phone, msg, env).catch(() => {});
      }
    } catch (err) {
      failureCount++;
      failureDetails.push({ id, error: err.message });
    }
  }

  // Audit Log
  const logId = await logBulkAction({
    adminPhone: phone,
    actionType: 'set_status',
    targetType: 'orders',
    targetValue: status,
    selectedIds: bulk.selectedIds,
    successCount,
    failureCount,
    skippedCount,
    failureDetails,
    notifyCustomers: bulk.notifyCustomers,
    cancellationReason: bulk.cancellationReason
  }, env);

  session.state = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  const summary = 
    `✅ *Bulk Action Complete*\n\n` +
    `Action: *${status.toUpperCase()}*\n` +
    `Updated: ${successCount}\n` +
    `Skipped: ${skippedCount}\n` +
    `Failed: ${failureCount}\n` +
    `Notified: ${bulk.notifyCustomers ? successCount : 0}\n\n` +
    `Log ID: ${logId}`;

  return sendButtons(
    phone,
    summary,
    [{ id: 'admin_home', title: '🔧 Admin Menu' }],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// Bulk Items
// ─────────────────────────────────────────────────────────────

async function handleBulkItemsAction(phone, msg, session, env) {
  if (msg.id === 'ba_mi_avail' || msg.id === 'ba_mi_unavail') {
    session.adminCtx.bulk.action = 'set_availability';
    session.adminCtx.bulk.targetValue = (msg.id === 'ba_mi_avail' ? 1 : 0);
    session.state = 'admin_bulk_items_select';
    await saveSession(phone, session, env);
    return showBulkItemsList(phone, session, env);
  }
  return handleBulkMenu(phone, { id: 'bulk_items' }, session, env);
}

async function showBulkItemsList(phone, session, env) {
  const { bulk } = session.adminCtx;
  const pageSize = 8;
  const offset = bulk.page * pageSize;

  const { items, total } = await getMenuItemsPaginated(env, pageSize, offset);

  if (!items.length && bulk.page === 0) {
    return sendText(phone, '📭 No menu items found.', env);
  }

  const rows = items.map(i => {
    const isSelected = bulk.selectedIds.includes(i.id);
    return {
      id: `bs_i_${i.id}`,
      title: `${isSelected ? '✅' : '⬜'} ${i.name}`,
      description: `${i.is_available ? 'Available' : 'Unavailable'} | ₦${i.price.toFixed(2)}`
    };
  });

  if (offset + pageSize < total) {
    rows.push({ id: 'bulk_page_next', title: '➡️ Next Page' });
  }
  if (bulk.page > 0) {
    rows.push({ id: 'bulk_page_prev', title: '⬅️ Prev Page' });
  }

  const footer = `Page ${bulk.page + 1} of ${Math.ceil(total / pageSize)} | ${bulk.selectedIds.length} selected`;

  return sendList(
    phone,
    `🍽️ *Select Items* to mark *${bulk.targetValue === 1 ? 'AVAILABLE' : 'UNAVAILABLE'}*\n\n${footer}`,
    'Select Items',
    [{ title: 'Menu Items', rows }],
    env
  );
}

async function handleBulkItemsSelect(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id === 'bulk_page_next') {
    bulk.page++;
    await saveSession(phone, session, env);
    return showBulkItemsList(phone, session, env);
  }
  if (msg.id === 'bulk_page_prev') {
    bulk.page = Math.max(0, bulk.page - 1);
    await saveSession(phone, session, env);
    return showBulkItemsList(phone, session, env);
  }

  if (msg.id?.startsWith('bs_i_')) {
    const itemId = parseInt(msg.id.replace('bs_i_', ''), 10);
    const idx = bulk.selectedIds.indexOf(itemId);
    if (idx > -1) {
      bulk.selectedIds.splice(idx, 1);
    } else {
      bulk.selectedIds.push(itemId);
    }
    await saveSession(phone, session, env);
    return showBulkItemsList(phone, session, env);
  }

  if (msg.id === 'bulk_items_confirm' || (msg.text || '').toUpperCase() === 'REVIEW') {
    if (!bulk.selectedIds.length) {
      return sendText(phone, '⚠️ Please select at least one item first.', env);
    }
    session.state = 'admin_bulk_items_confirm';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `⚠️ *Confirm Bulk Update*\n\nMark ${bulk.selectedIds.length} items as *${bulk.targetValue === 1 ? 'AVAILABLE' : 'UNAVAILABLE'}*?`,
      [
        { id: 'bulk_confirm_yes', title: 'Yes, Confirm' },
        { id: 'admin_back',       title: '⬅️ Back'        }
      ],
      env
    );
  }

  if (msg.id === 'bulk_clear') {
    bulk.selectedIds = [];
    await saveSession(phone, session, env);
    return showBulkItemsList(phone, session, env);
  }

  return sendButtons(
    phone,
    `Selected: ${bulk.selectedIds.length} items.\nTap items to select, then review.`,
    [
      { id: 'bulk_items_confirm', title: '✅ Review' },
      { id: 'bulk_clear',  title: '🧹 Clear'  },
      { id: 'admin_home',  title: '❌ Cancel' }
    ],
    env
  );
}

async function handleBulkItemsConfirm(phone, msg, session, env) {
  if (msg.id === 'bulk_confirm_yes') {
    const { bulk } = session.adminCtx;
    const isAvail = bulk.targetValue === 1;

    try {
      await bulkUpdateMenuAvailability(bulk.selectedIds, isAvail, env);
      await bustMenuCache(env);

      // Audit Log
      const logId = await logBulkAction({
        adminPhone: phone,
        actionType: 'set_availability',
        targetType: 'menu_items',
        targetValue: isAvail ? '1' : '0',
        selectedIds: bulk.selectedIds,
        successCount: bulk.selectedIds.length
      }, env);

      session.state = 'admin_idle';
      session.adminCtx = {};
      await saveSession(phone, session, env);

      return sendButtons(
        phone,
        `✅ *Bulk Update Complete*\n\n${bulk.selectedIds.length} items marked ${isAvail ? 'AVAILABLE' : 'UNAVAILABLE'}.\n\nLog ID: ${logId}`,
        [{ id: 'admin_home', title: '🔧 Admin Menu' }],
        env
      );
    } catch (err) {
      console.error('[Admin] Bulk item update failed:', err);
      return sendText(phone, '⚠️ Failed to complete bulk update. Please try again.', env);
    }
  }

  return showBulkItemsList(phone, session, env);
}
