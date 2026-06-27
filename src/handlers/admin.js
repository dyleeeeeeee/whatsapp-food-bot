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
  sendText, sendButtons, sendList, sendFlow, sendTemplate,
} from '../whatsapp.js';
import {
  getSession, saveSession, bustMenuCache, formatPrice, parsePrice, MAX_PRICE, CURRENCY_SYMBOL,
} from '../session.js';
import {
  getAllMenuItems, getMenuItem, getCategories, getFullMenu,
  createMenuItem, updateMenuItem, deleteMenuItem,
  getOrder, updateOrderStatus,
  bulkUpdateOrderStatus, bulkUpdateMenuAvailability,
  getMenuItemsPaginated, getActiveOrdersPaginated,
  logBulkAction,
  bulkDeleteMenuItems, bulkCreateMenuItems, bulkEditMenuItems,
  getCategoryById, updateCategory,
  bulkCreateCategories, bulkDeleteCategoriesWithItems,
  moveAllItemsFromCategory, bulkMoveItemsToCategory,
  getItemCountsByCategory,
  logRefund, getStats,
} from '../db.js';
import { sanitize, isValidHttpsUrl } from '../security.js';
import { alertAdmin } from '../lib/alert.js';
import { refundFlutterwaveTransaction } from '../payments/flutterwave.js';

const VALID_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'];

// EDGE-07: allowed status transitions. 'delivered' and 'cancelled' are terminal.
// A status may always be set to itself (caught earlier as a no-op).
const STATUS_TRANSITIONS = {
  pending:   ['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'],
  confirmed: ['confirmed', 'preparing', 'ready', 'delivered', 'cancelled'],
  preparing: ['preparing', 'ready', 'delivered', 'cancelled'],
  ready:     ['ready', 'delivered', 'cancelled'],
  delivered: ['delivered'],
  cancelled: ['cancelled'],
};

function isAllowedTransition(current, next) {
  const allowed = STATUS_TRANSITIONS[current];
  // Unknown current status — be permissive rather than strand the admin.
  if (!allowed) return true;
  return allowed.includes(next);
}

// GAP (admin selectedIds race): bulk selections live under their OWN KV key —
// the same dedicated-key + read-merge pattern the cart already uses (see
// session.js). The session blob is eventually consistent, so two rapid taps can
// each read a stale blob and the second write clobbers the first, silently
// dropping a selection. By making each toggle a read-modify-write against the
// dedicated selection key, every tap merges against the latest persisted set.
const SELECTION_TTL_SECONDS = 60 * 60; // selections are short-lived

function selectionKey(phone) {
  return 'bulksel:' + phone;
}

/**
 * Toggle an id in the bulk selection with a read-modify-write on the dedicated
 * KV key, then mirror the merged set onto `bulk.selectedIds` for rendering.
 * De-duplicated (Set) so rapid taps can never double-add or mis-toggle.
 */
async function toggleSelection(phone, bulk, id, env) {
  let persisted = bulk.selectedIds || [];
  try {
    const raw = await env.SESSION_KV.get(selectionKey(phone));
    if (raw) persisted = JSON.parse(raw);
  } catch { /* fall back to in-session copy */ }

  const set = new Set(persisted);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  bulk.selectedIds = [...set];

  try {
    await env.SESSION_KV.put(
      selectionKey(phone),
      JSON.stringify(bulk.selectedIds),
      { expirationTtl: SELECTION_TTL_SECONDS }
    );
  } catch (err) {
    console.error('[Admin] selection persist failed (continuing):', err && err.message);
  }
  return bulk.selectedIds;
}

/**
 * GAP (static-flow drift): the Add-Item WhatsApp Flow has a STATIC category
 * dropdown baked into flows/add-item.json. When categories change (add/rename)
 * that dropdown drifts out of sync with the DB. We can't edit the published
 * Flow from here, so we set a 'flow:stale' KV flag (read by ops/monitoring) and
 * warn the admin to re-sync the Flow's category list. Best-effort, never throws.
 */
const FLOW_STALE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

async function markFlowStale(env, reason) {
  if (!env || !env.SESSION_KV) return;
  try {
    await env.SESSION_KV.put(
      'flow:stale',
      JSON.stringify({ reason: reason || 'category change', at: new Date().toISOString() }),
      { expirationTtl: FLOW_STALE_TTL_SECONDS }
    );
  } catch (err) {
    console.error('[Admin] markFlowStale KV write failed (continuing):', err && err.message);
  }
}

// Only nag the admin about Flow drift when the static Add-Item Flow is actually
// in use; otherwise the warning is noise.
function flowDriftNote(env) {
  return env && env.ADD_ITEM_FLOW_ID
    ? '\n\n⚠️ The Add-Item Flow category list is now out of date — update the Flow dropdown to match.'
    : '';
}

/** Seed the dedicated selection key when a bulk flow starts (empty set). */
async function resetSelection(phone, env) {
  try {
    await env.SESSION_KV.put(selectionKey(phone), '[]', { expirationTtl: SELECTION_TTL_SECONDS });
  } catch { /* best effort */ }
}

/**
 * Re-read the authoritative selection set from KV at commit time so a write
 * that lost the race in the session blob is still honored. Returns an array.
 */
async function loadSelection(phone, bulk, env) {
  try {
    const raw = await env.SESSION_KV.get(selectionKey(phone));
    if (raw) {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) {
        bulk.selectedIds = ids;
        return ids;
      }
    }
  } catch { /* fall back to in-session copy */ }
  return bulk.selectedIds || [];
}

/**
 * EDGE-11: send a terminal error with an admin_home button so the admin is
 * never stranded with a text-only dead end.
 */
function sendAdminError(phone, body, env) {
  return sendButtons(phone, body, [{ id: 'admin_home', title: '🔧 Admin Menu' }], env);
}

// UX-16 / EDGE-17: canned bulk-cancel reasons. Codes map to customer-facing
// sentences; "Other" lets the admin type a custom reason, "Skip" sends none.
const BULK_CANCEL_REASONS = {
  out_of_stock: 'Some items are out of stock.',
  closed:       'We are closed right now.',
  unreachable:  'We could not reach you to confirm the order.',
  payment:      'There was a problem with the payment.',
};

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export async function handleAdminMessage(phone, msg, env, preSession = null) {
  // BUG-13: reuse the caller-supplied session when batching, else load it.
  const session = preSession || await getSession(phone, env);

  // Ensure adminCtx always exists — old sessions may predate this field
  session.adminCtx = session.adminCtx || {};

  // UX-13: Add-Item Flow completion arrives as a flow_reply — route it to the
  // dedicated handler regardless of the persisted state.
  if (msg.type === 'flow_reply') {
    if (session.state === 'admin_add_item_flow') {
      return handleAddItemFlowReply(phone, msg, session, env);
    }
    // Unknown flow reply — fall back to the admin menu.
    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return showAdminMenu(phone, env);
  }

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

  // GAP (/stats): a quick read-only summary surface, reachable by typing /STATS
  // (or STATS) or via the admin menu row. Doesn't change session state.
  if (text === '/STATS' || text === 'STATS' || msg.id === 'admin_stats') {
    return showStats(phone, env);
  }

  // BACK command: go back one step in multi-step flows
  if (text === 'BACK' || msg.id === 'admin_back') {
    return handleBackNavigation(phone, session, env);
  }

  // Stale-state recovery: these button IDs must route correctly regardless of KV state
  // UX-12: route Update Status to the tappable order list by default.
  if (msg.id === 'admin_update_status') {
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return viewOrders(phone, session, env);
  }
  // UX-12: explicit fallback to the typed-numeric-ID path.
  if (msg.id === 'admin_update_status_id') {
    session.state    = 'admin_update_status_id';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendText(phone, '📦 Enter the *Order ID* to update:\n\nSend *CANCEL* to abort.', env);
  }
  if (msg.id === 'admin_bulk_menu') {
    return showBulkMenu(phone, session, env);
  }
  if (msg.id?.startsWith('ba_os_')) {
    if (!session.adminCtx.bulk?.selectedIds) {
      session.adminCtx.bulk = { type: 'orders', selectedIds: [], page: 0 };
    }
    session.state = 'admin_bulk_orders_action';
    return handleBulkOrdersAction(phone, msg, session, env);
  }

  switch (session.state) {
    case 'admin_idle':                return handleAdminIdle(phone, msg, session, env);
    case 'admin_add_category':        return handleAddCategory(phone, msg, session, env);
    case 'admin_view_categories':     return handleViewCategories(phone, msg, session, env);
    case 'admin_add_item_flow':       return handleAddItemFlowReply(phone, msg, session, env);
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
    
    // Bulk Actions — Orders
    case 'admin_bulk_menu':                  return handleBulkMenu(phone, msg, session, env);
    case 'admin_bulk_orders_action':         return handleBulkOrdersAction(phone, msg, session, env);
    case 'admin_bulk_orders_select':         return handleBulkOrdersSelect(phone, msg, session, env);
    case 'admin_bulk_orders_reason':         return handleBulkOrdersReason(phone, msg, session, env);
    case 'admin_bulk_orders_confirm':        return handleBulkOrdersConfirm(phone, msg, session, env);
    // Bulk Actions — Items (legacy availability toggle)
    case 'admin_bulk_items_action':          return handleBulkItemsAction(phone, msg, session, env);
    case 'admin_bulk_items_select':          return handleBulkItemsSelect(phone, msg, session, env);
    case 'admin_bulk_items_confirm':         return handleBulkItemsConfirm(phone, msg, session, env);
    // Bulk Actions — Items (add/remove/edit)
    case 'admin_bulk_items_add_category':    return handleBulkItemsAddCategory(phone, msg, session, env);
    case 'admin_bulk_items_add_paste':       return handleBulkItemsAddPaste(phone, msg, session, env);
    case 'admin_bulk_items_add_review':      return handleBulkItemsAddReview(phone, msg, session, env);
    case 'admin_bulk_items_remove_select':   return handleBulkItemsRemoveSelect(phone, msg, session, env);
    case 'admin_bulk_items_remove_confirm':  return handleBulkItemsRemoveConfirm(phone, msg, session, env);
    case 'admin_bulk_items_edit_action':     return handleBulkItemsEditAction(phone, msg, session, env);
    case 'admin_bulk_items_edit_value':      return handleBulkItemsEditValue(phone, msg, session, env);
    case 'admin_bulk_items_edit_select':     return handleBulkItemsEditSelect(phone, msg, session, env);
    case 'admin_bulk_items_edit_confirm':    return handleBulkItemsEditConfirm(phone, msg, session, env);
    // Bulk Actions — Categories
    case 'admin_bulk_cats_type':             return handleBulkCatsType(phone, msg, session, env);
    case 'admin_bulk_cats_add_paste':        return handleBulkCatsAddPaste(phone, msg, session, env);
    case 'admin_bulk_cats_add_review':       return handleBulkCatsAddReview(phone, msg, session, env);
    case 'admin_bulk_cats_rename_select':    return handleBulkCatsRenameSelect(phone, msg, session, env);
    case 'admin_bulk_cats_rename_value':     return handleBulkCatsRenameValue(phone, msg, session, env);
    case 'admin_bulk_cats_delete_select':    return handleBulkCatsDeleteSelect(phone, msg, session, env);
    case 'admin_bulk_cats_delete_mode':      return handleBulkCatsDeleteMode(phone, msg, session, env);
    case 'admin_bulk_cats_delete_target':    return handleBulkCatsDeleteTarget(phone, msg, session, env);
    case 'admin_bulk_cats_delete_confirm':   return handleBulkCatsDeleteConfirm(phone, msg, session, env);
    case 'admin_bulk_cats_move_source':      return handleBulkCatsMoveSource(phone, msg, session, env);
    case 'admin_bulk_cats_move_target':      return handleBulkCatsMoveTarget(phone, msg, session, env);
    case 'admin_bulk_cats_move_confirm':     return handleBulkCatsMoveConfirm(phone, msg, session, env);

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
    '🔧 *Admin Panel*\nWhat would you like to manage?\n\n_Anytime: type ADMIN to return here, BACK to go back, CANCEL to abort._',
    'Admin Actions',
    [
      {
        title: 'Menu Management',
        rows: [
          { id: 'admin_add_item',    title: 'Add Item',      description: 'Add a new menu item'          },
          { id: 'admin_edit_item',   title: 'Edit Item',     description: 'Update price, name, etc.'     },
          { id: 'admin_delete_item', title: 'Delete Item',   description: 'Remove item from menu'        },
          { id: 'admin_add_cat',     title: 'Add Category',  description: 'Create a new menu category'   },
          { id: 'admin_view_cats',   title: 'View Categories', description: 'List all categories'         },
          { id: 'admin_toggle_item', title: 'Toggle Avail.', description: 'Mark item available/unavail.' },
        ],
      },
      {
        title: 'Operations',
        rows: [
          { id: 'admin_view_orders',   title: 'View Orders',   description: 'See pending/active orders' },
          { id: 'admin_update_status', title: 'Update Status', description: 'Change an order status'    },
          { id: 'admin_bulk_menu',     title: 'Bulk Actions',  description: 'Manage multiple items/orders' },
          { id: 'admin_stats',         title: 'Stats',         description: "Today's orders & paid rate" },
        ],
      },
      {
        title: 'Testing',
        rows: [
          { id: 'admin_user_mode',    title: '👤 User Mode',   description: 'Experience app as a customer' },
        ],
      },
    ],
    env
  );
}

/**
 * GAP (/stats): render a small read-only operations summary. getStats is a
 * pure aggregate read (db.js) — no session mutation, so this is safe to call
 * from any state.
 */
async function showStats(phone, env) {
  const s = await getStats(env);
  const pct = Math.round((s.paidRate || 0) * 100);
  return sendButtons(
    phone,
    '📊 *Today at a glance*\n\n' +
    `Orders today: *${s.ordersToday}*\n` +
    `Paid today: *${s.paidToday}* (${pct}%)\n` +
    `Pending payment: *${s.pendingCount}*`,
    [
      { id: 'admin_view_orders', title: '📦 View Orders' },
      { id: 'admin_home',        title: '🔧 Admin Menu' },
    ],
    env
  );
}

async function handleAdminIdle(phone, msg, session, env) {
  const id = msg.id || '';

  if (id === 'admin_stats') return showStats(phone, env);

  if (id === 'admin_add_item') {
    session.adminCtx = {};
    // UX-13: drive Add-Item via a WhatsApp Flow when configured.
    if (env.ADD_ITEM_FLOW_ID) {
      return startAddItemFlow(phone, session, env);
    }
    session.state = 'admin_add_item_name';
    await saveSession(phone, session, env);
    return sendText(phone, '➕ *Add New Item*\n\nEnter the item *name*:\n\nSend *CANCEL* to abort.', env);
  }
  if (id === 'admin_add_cat' || id === 'admin_add_another_cat') {
    session.state = 'admin_add_category';
    await saveSession(phone, session, env);
    return sendText(phone, '📂 Enter the new *category name*:\n\nSend *CANCEL* to abort.', env);
  }
  if (id === 'admin_view_cats') {
    session.state = 'admin_view_categories';
    await saveSession(phone, session, env);
    return showCategoriesList(phone, session, env);
  }
  if (id === 'admin_edit_item') {
    return startEditFlow(phone, session, env);
  }
  if (id === 'admin_delete_item') return startDeleteFlow(phone, session, env);
  if (id === 'admin_toggle_item') return startToggleFlow(phone, session, env);
  if (id === 'admin_view_orders') return viewOrders(phone, session, env);
  // UX-12: default Update Status to the tappable order list.
  if (id === 'admin_update_status') {
    return viewOrders(phone, session, env);
  }
  if (id === 'admin_update_status_id') {
    session.state = 'admin_update_status_id';
    await saveSession(phone, session, env);
    return sendText(phone, '📦 Enter the *Order ID* to update:\n\nSend *CANCEL* to abort.', env);
  }
  if (id === 'admin_bulk_menu') {
    return showBulkMenu(phone, session, env);
  }

  if (id === 'admin_user_mode') {
    session.adminUserMode = true;
    session.state = 'idle';
    await saveSession(phone, session, env);
    return sendText(phone, '👤 *User Mode Activated*\n\nYou can now experience the app as a customer. Tap "Exit User Mode" in the cart to return to admin panel.', env)
      .then(() => import('../handlers/user.js').then(m => m.handleUserMessage(phone, { type: 'text', text: 'MENU' }, env)));
  }

  // Route any bulk_* re-entry buttons (from success screens) through handleBulkMenu
  if (id.startsWith('bulk_')) {
    return handleBulkMenu(phone, msg, session, env);
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
    'admin_add_item_description':{ newState: 'admin_add_item_price', prompt: '💰 Enter the *price* (e.g. 1500):' },
    'admin_add_item_image':      { newState: 'admin_add_item_description', prompt: null }, // Will re-show description prompt
    'admin_edit_item_field':     { newState: 'admin_edit_item_select', prompt: null }, // Will re-show item list
    'admin_edit_item_value':     { newState: 'admin_edit_item_field', prompt: null }, // Will re-show field list
    'admin_update_status_value': { newState: 'admin_orders_list', prompt: null }, // Will re-show order list
    'admin_update_status_confirm': { newState: 'admin_update_status_value', prompt: null }, // Will re-show status list
  };

  const backInfo = backMap[state];
  if (!backInfo) {
    // EDGE-20: don't dead-end. Bulk states fall back to the bulk menu; any
    // other unmapped state falls back to the admin menu.
    if (typeof state === 'string' && state.startsWith('admin_bulk_')) {
      return showBulkMenu(phone, session, env);
    }
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return showAdminMenu(phone, env);
  }

  session.state = backInfo.newState;
  await saveSession(phone, session, env);

  // Special handling for states that show lists
  if (state === 'admin_add_item_price') {
    return showCategoryListForItem(phone, adminCtx?.newItem?.name, env);
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

  // EDGE-20: edit-item back steps re-render the relevant picker/list.
  if (state === 'admin_edit_item_field') {
    return showEditItemPicker(phone, session, env);
  }
  if (state === 'admin_edit_item_value') {
    return handleEditItemSelect(phone, { id: `edit_${adminCtx?.editItemId}` }, session, env);
  }

  if (state === 'admin_update_status_value' || state === 'admin_update_status_confirm') {
    return viewOrders(phone, session, env);
  }

  return sendText(phone, backInfo.prompt + '\n\nSend *CANCEL* to abort.', env);
}

// ─────────────────────────────────────────────────────────────
// View Categories
// ─────────────────────────────────────────────────────────────

async function showCategoriesList(phone, session, env) {
  const categories = await getCategories(env);
  const menu = await getFullMenu(env);

  if (!categories.length) {
    return sendButtons(
      phone,
      '📭 No categories yet.',
      [{ id: 'admin_add_cat', title: '➕ Add Category' }],
      env
    );
  }

  const rows = categories.map(cat => ({
    id: `cat_${cat.id}`,
    title: cat.name,
    description: `${(menu.itemsByCategory[cat.id] || []).length} items`
  }));

  return sendList(
    phone,
    '📂 *Categories*\nSelect a category to view its items:',
    'Categories',
    [{ title: 'All Categories', rows }],
    env
  );
}

async function handleViewCategories(phone, msg, session, env) {
  if (msg.id === 'admin_home' || (msg.text || '').toUpperCase() === 'CANCEL') {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return showAdminMenu(phone, env);
  }

  if (msg.type === 'list_reply' && msg.id?.startsWith('cat_')) {
    const categoryId = parseInt(msg.id.replace('cat_', ''), 10);
    const menu = await getFullMenu(env);
    const category = await env.DB.prepare(
      'SELECT id, name FROM MenuCategories WHERE id = ?'
    ).bind(categoryId).first();

    if (!category) {
      return showCategoriesList(phone, session, env);
    }

    const items = menu.itemsByCategory[categoryId] || [];
    if (!items.length) {
      return sendButtons(
        phone,
        `😕 No items in *${category.name}* yet.`,
        [
          { id: 'admin_view_cats', title: '📂 View Categories' },
          { id: 'admin_home',      title: '🔧 Admin Menu'      },
        ],
        env
      );
    }

    const itemText = items.map(i =>
      `• *${i.name}*\n  ${formatPrice(i.price)}${i.is_available ? '' : ' (unavailable)'}`
    ).join('\n\n');

    return sendButtons(
      phone,
      `📂 *${category.name}*\n\n${itemText}`,
      [
        { id: 'admin_view_cats', title: '📂 View Categories' },
        { id: 'admin_home', title: '🔧 Admin Menu' },
      ],
      env,
      category.name
    );
  }

  return showCategoriesList(phone, session, env);
}

// ─────────────────────────────────────────────────────────────
// Add Category
// ─────────────────────────────────────────────────────────────

async function handleAddCategory(phone, msg, session, env) {
  // Button press while already in add-category state — re-prompt
  if (msg.id === 'admin_add_another_cat' || msg.type === 'button_reply' || msg.type === 'list_reply') {
    return sendText(phone, '📂 Enter the new *category name*:\n\nSend *CANCEL* to abort.', env);
  }

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
    console.log('[Admin] Category created:', name, 'DB id:', result.meta?.last_row_id);
    await bustMenuCache(env);
    await markFlowStale(env, `category added: ${name}`); // GAP: static Add-Item Flow drift

    // If admin came from the add-item flow (no categories existed), send them back there
    if (session.adminCtx.returnFlow === 'add_item' && session.adminCtx.newItem) {
      delete session.adminCtx.returnFlow;
      session.state = 'admin_add_item_category';
      await saveSession(phone, session, env);
      return sendText(
        phone,
        `✅ Category *${name}* created!\n\nNow choose a category for *${session.adminCtx.newItem.name}*:`,
        env
      ).then(() => showCategoryListForItem(phone, session.adminCtx.newItem.name, env));
    }

    // Keep state as admin_add_category to allow adding multiple categories
    return sendButtons(
      phone,
      `✅ Category *${name}* created!${flowDriftNote(env)}`,
      [
        { id: 'admin_add_another_cat', title: '➕ Add Another' },
        { id: 'admin_home', title: '🔧 Admin Menu' },
      ],
      env
    );
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
// Add Item — WhatsApp Flow (UX-13, only when ADD_ITEM_FLOW_ID is set)
// ─────────────────────────────────────────────────────────────

async function startAddItemFlow(phone, session, env) {
  session.state = 'admin_add_item_flow';
  await saveSession(phone, session, env);

  // The Flow's category dropdown is static (flows/add-item.json), so no data is
  // passed. If the Flow send fails, fall back to the text add flow so the admin
  // is never stranded.
  const flowToken = `add_item_${Date.now()}`;
  try {
    return await sendFlow(
      phone,
      '➕ *Add New Item*\nTap below to fill in the item details.',
      {
        flowId:   env.ADD_ITEM_FLOW_ID,
        flowToken,
        flowCta:  'Add Item',
        screenId: env.ADD_ITEM_FLOW_SCREEN || 'ADD_ITEM',
        data:     {},
      },
      env
    );
  } catch (err) {
    console.error('[Admin] Add-Item Flow send failed, falling back to text flow:', err);
    session.state = 'admin_add_item_name';
    await saveSession(phone, session, env);
    return sendText(phone, '➕ *Add New Item*\n\nEnter the item *name*:\n\nSend *CANCEL* to abort.', env);
  }
}

async function handleAddItemFlowReply(phone, msg, session, env) {
  // The admin tapped a button instead of completing the Flow, or sent text.
  if (msg.type !== 'flow_reply') {
    const t = (msg.text || '').toUpperCase().trim();
    if (t === 'CANCEL' || msg.id === 'admin_home') {
      session.state    = 'admin_idle';
      session.adminCtx = {};
      await saveSession(phone, session, env);
      return showAdminMenu(phone, env);
    }
    // Re-launch the Flow so the admin isn't stranded.
    return startAddItemFlow(phone, session, env);
  }

  const data = msg.data || {};
  const name = sanitize(data.name || '', 100);
  const catId = parseInt(data.category_id ?? data.category, 10);
  const price = parsePrice(String(data.price ?? ''));
  const description = sanitize(data.description || '', 300);
  const rawImg = (data.image_url || '').trim();

  // Validate the submitted Flow data; on any problem, re-launch the Flow.
  const problems = [];
  if (name.length < 2) problems.push('• Name must be at least 2 characters.');
  if (isNaN(catId)) problems.push('• Please choose a category.');
  if (price === null) problems.push(`• Price must be a number between 1 and ${formatPrice(MAX_PRICE)}.`); // EDGE-21
  let imageUrl = '';
  if (rawImg) {
    if (!isValidHttpsUrl(rawImg)) problems.push('• Image URL must start with https://');
    else imageUrl = rawImg;
  }

  if (problems.length) {
    return sendButtons(
      phone,
      '⚠️ Could not add the item:\n\n' + problems.join('\n'),
      [
        { id: 'admin_add_item', title: '➕ Try Again' },
        { id: 'admin_home',     title: '🔧 Admin Menu' },
      ],
      env
    );
  }

  // Reject a category that doesn't exist (EDGE-11: re-offer the menu on failure).
  const cat = await getCategories(env).then(cats => cats.find(c => c.id === catId));
  if (!cat) {
    return sendButtons(
      phone,
      '⚠️ That category no longer exists. Please try again.',
      [
        { id: 'admin_add_item', title: '➕ Try Again' },
        { id: 'admin_home',     title: '🔧 Admin Menu' },
      ],
      env
    );
  }

  // Duplicate-name guard (mirrors the text flow).
  const existing = await env.DB.prepare(
    'SELECT id FROM MenuItems WHERE LOWER(name) = LOWER(?)'
  ).bind(name).first();
  if (existing) {
    return sendButtons(
      phone,
      `⚠️ An item named "${name}" already exists.`,
      [
        { id: 'admin_add_item', title: '➕ Try Again' },
        { id: 'admin_home',     title: '🔧 Admin Menu' },
      ],
      env
    );
  }

  // Create the item exactly once.
  const itemId = await createMenuItem(
    { categoryId: catId, name, description, price, imageUrl }, env
  );
  await bustMenuCache(env);
  console.log('[Admin] Item created via Flow:', name, 'ID:', itemId);

  session.state    = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `✅ *${name}* added to menu!\n💰 ${formatPrice(price)}`,
    [
      { id: 'admin_add_item', title: '➕ Add Another Item' },
      { id: 'admin_home',     title: '🔧 Admin Menu'       },
    ],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// Add Item — multi-step flow
// ─────────────────────────────────────────────────────────────

async function handleAddItemName(phone, msg, session, env) {
  // Handle global commands to escape stuck state
  const t = (msg.text || '').toUpperCase().trim();
  const id = msg.id || '';
  if (t === 'CANCEL' || id === 'cmd_cancel') {
    session.state = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return showAdminMenu(phone, env);
  }

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

  return showCategoryListForItem(phone, name, env);
}

async function showCategoryListForItem(phone, itemName, env) {
  const cats = await getCategories(env);
  if (!cats.length) {
    return sendButtons(
      phone,
      '⚠️ No categories exist yet.\n\nCreate one first, then continue adding your item.',
      [{ id: 'admin_add_cat', title: '➕ Create Category' }],
      env
    );
  }
  const rows = cats.map(c => ({ id: `acat_${c.id}`, title: c.name }));
  return sendList(
    phone,
    `📂 Choose a *category* for *${itemName || 'this item'}*:\n\nSend *CANCEL* to abort.`,
    'Select Category',
    [{ title: 'Categories', rows }],
    env
  );
}

async function handleAddItemCategory(phone, msg, session, env) {
  // BUG-05 FIX: guard corrupted session
  if (!session.adminCtx?.newItem) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendAdminError(phone, '⚠️ Session lost. Please start over.', env);
  }

  // Admin wants to create a new category while mid-way through add-item
  if (msg.id === 'admin_add_cat') {
    session.adminCtx.returnFlow = 'add_item';
    session.state = 'admin_add_category';
    await saveSession(phone, session, env);
    return sendText(phone, '📂 Enter the new *category name*:\n\nSend *CANCEL* to abort.', env);
  }

  if (!msg.id?.startsWith('acat_')) {
    // Re-render the list instead of a text-only warning
    return showCategoryListForItem(phone, session.adminCtx.newItem.name, env);
  }

  const catId = parseInt(msg.id.replace('acat_', ''), 10);
  // Verify category exists
  const cat = await getCategories(env).then(cats => cats.find(c => c.id === catId));
  if (!cat) {
    return showCategoryListForItem(phone, session.adminCtx.newItem.name, env);
  }

  session.adminCtx.newItem.categoryId = catId;
  session.state = 'admin_add_item_price';
  await saveSession(phone, session, env);
  return sendText(phone, '💰 Enter the *price* (e.g. 1500):\n\nSend *BACK* to choose a different category.', env);
}

async function handleAddItemPrice(phone, msg, session, env) {
  // BUG-05 FIX: guard corrupted session
  if (!session.adminCtx?.newItem) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendAdminError(phone, '⚠️ Session lost. Please start over.', env);
  }

  // Handle global commands to escape stuck state
  const t = (msg.text || '').toUpperCase().trim();
  const id = msg.id || '';
  if (t === 'CANCEL' || id === 'cmd_cancel') {
    session.state = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return showAdminMenu(phone, env);
  }
  if (t === 'BACK' || id === 'cmd_back') {
    session.state = 'admin_add_item_category';
    delete session.adminCtx.newItem.categoryId;
    await saveSession(phone, session, env);
    return showCategoryListForItem(phone, session.adminCtx.newItem.name, env);
  }

  // EDGE-21: validate with parsePrice — rejects non-numeric/zero/over-ceiling.
  const price = parsePrice(msg.text || '');
  if (price === null) {
    return sendText(
      phone,
      '⚠️ Enter a valid price (e.g. 1500).\n\n' +
      `Price must be a number between 1 and ${formatPrice(MAX_PRICE)}.\n` +
      'Send *CANCEL* to abort or *BACK* to change the category.',
      env
    );
  }

  session.adminCtx.newItem.price = price;
  session.state = 'admin_add_item_description';
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    '📝 Enter a *description* for the item (optional):\n\n' +
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
    return sendAdminError(phone, '⚠️ Session lost. Please start over.', env);
  }

  // Handle global commands to escape stuck state
  const t = (msg.text || '').toUpperCase().trim();
  const id = msg.id || '';
  if (t === 'CANCEL' || id === 'cmd_cancel') {
    session.state = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return showAdminMenu(phone, env);
  }
  if (t === 'BACK' || id === 'cmd_back') {
    session.state = 'admin_add_item_price';
    delete session.adminCtx.newItem.price;
    await saveSession(phone, session, env);
    return sendText(phone, '💰 Enter the *price* (e.g. 1500):', env);
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
    return sendAdminError(phone, '⚠️ Session lost. Please start over.', env);
  }

  // Handle global commands to escape stuck state
  const t = (msg.text || '').toUpperCase().trim();
  const id = msg.id || '';
  if (t === 'CANCEL' || id === 'cmd_cancel') {
    session.state = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return showAdminMenu(phone, env);
  }

  // Handle BACK navigation
  if (t === 'BACK' || id === 'cmd_back') {
    session.state = 'admin_add_item_description';
    delete session.adminCtx.newItem.description;
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

  const itemId = await createMenuItem(item, env);
  await bustMenuCache(env);
  console.log('[Admin] Item created:', item.name, 'ID:', itemId);

  session.state    = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `✅ *${item.name}* added to menu!\n💰 ₦${item.price.toFixed(2)}`,
    [
      { id: 'admin_add_item',  title: '➕ Add Another Item' },
      { id: 'admin_home',      title: '🔧 Admin Menu'       },
    ],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// Edit Item
// ─────────────────────────────────────────────────────────────

// UX-11: page size 8 so 8 items + Prev + Next ≤ 10 rows per WhatsApp list.
const ITEM_PICKER_PAGE_SIZE = 8;

/**
 * UX-11: render a paginated single-select item picker.
 * `prefix` is the row-id prefix (edit_/del_/tog_), `prevId`/`nextId` are the
 * nav row ids the matching select handler watches for.
 */
async function showItemPicker(phone, session, env, opts) {
  const { prefix, prevId, nextId, body, btnLabel, sectionTitle, descFor } = opts;
  const page   = Math.max(0, session.adminCtx.pickerPage || 0);
  const offset = page * ITEM_PICKER_PAGE_SIZE;
  const { items, total } = await getMenuItemsPaginated(env, ITEM_PICKER_PAGE_SIZE, offset);

  if (!items.length && page === 0) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '📭 No items in menu yet. Add one first.',
      [{ id: 'admin_add_item', title: '➕ Add Item' }],
      env
    );
  }
  if (!items.length && page > 0) {
    session.adminCtx.pickerPage = page - 1;
    await saveSession(phone, session, env);
    return showItemPicker(phone, session, env, opts);
  }

  const rows = items.map(i => ({
    id:          `${prefix}${i.id}`,
    title:       i.name,
    description: descFor(i),
  }));

  if (page > 0) rows.push({ id: prevId, title: '⬅️ Prev Page' });
  if (offset + ITEM_PICKER_PAGE_SIZE < total) rows.push({ id: nextId, title: '➡️ Next Page' });

  const totalPages = Math.max(1, Math.ceil(total / ITEM_PICKER_PAGE_SIZE));
  await saveSession(phone, session, env);

  return sendList(
    phone,
    `${body} — Page ${page + 1} of ${totalPages}`,
    btnLabel,
    [{ title: sectionTitle, rows }],
    env
  );
}

async function startEditFlow(phone, session, env) {
  session.adminCtx.pickerPage = 0;
  session.state = 'admin_edit_item_select';
  return showEditItemPicker(phone, session, env);
}

async function showEditItemPicker(phone, session, env) {
  return showItemPicker(phone, session, env, {
    prefix: 'edit_', prevId: 'edit_page_prev', nextId: 'edit_page_next',
    body: '✏️ *Edit Item*\nSelect an item to edit:',
    btnLabel: 'Choose', sectionTitle: 'Items',
    descFor: i => `${formatPrice(i.price)}${i.is_available ? '' : ' (unavail)'}`,
  });
}

async function handleEditItemSelect(phone, msg, session, env) {
  // UX-11: pagination navigation.
  if (msg.id === 'edit_page_next') {
    session.adminCtx.pickerPage = (session.adminCtx.pickerPage || 0) + 1;
    await saveSession(phone, session, env);
    return showEditItemPicker(phone, session, env);
  }
  if (msg.id === 'edit_page_prev') {
    session.adminCtx.pickerPage = Math.max(0, (session.adminCtx.pickerPage || 0) - 1);
    await saveSession(phone, session, env);
    return showEditItemPicker(phone, session, env);
  }
  if (!msg.id?.startsWith('edit_')) return showEditItemPicker(phone, session, env);

  const itemId = parseInt(msg.id.replace('edit_', ''), 10);
  const item   = await getMenuItem(itemId, env);
  if (!item) return sendAdminError(phone, '⚠️ Item not found.', env);

  session.adminCtx.editItemId = itemId;
  session.state = 'admin_edit_item_field';
  await saveSession(phone, session, env);

  const availLabel = item.is_available ? '✅ Available' : '❌ Unavailable';
  return sendList(
    phone,
    `✏️ Editing *${item.name}* (₦${item.price.toFixed(2)})\nWhich field to update?`,
    'Edit Field',
    [{
      title: 'Fields',
      rows: [
        { id: 'ef_name',         title: 'Name',         description: `Current: ${item.name.slice(0, 40)}` },
        { id: 'ef_price',        title: 'Price',        description: `Current: ₦${item.price.toFixed(2)}` },
        { id: 'ef_description',  title: 'Description',  description: `Current: ${(item.description || '(none)').slice(0, 40)}` },
        { id: 'ef_image_url',    title: 'Image URL',    description: `Current: ${(item.image_url || '(none)').slice(0, 40)}` },
        { id: 'ef_availability', title: 'Availability', description: `Currently ${availLabel}` },
        { id: 'ef_category',     title: 'Category',     description: 'Move to a different category' },
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

  // Availability: toggle immediately, no value step needed
  if (msg.id === 'ef_availability') {
    const item = await getMenuItem(session.adminCtx.editItemId, env);
    if (!item) return sendAdminError(phone, '⚠️ Item not found.', env);
    const newVal = item.is_available ? 0 : 1;
    await updateMenuItem(item.id, { is_available: newVal }, env);
    await bustMenuCache(env);
    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    const label = newVal ? '✅ Available' : '❌ Unavailable';
    return sendButtons(
      phone,
      `✅ *${item.name}* is now *${label}*.`,
      [
        { id: 'admin_edit_item', title: '✏️ Edit Another' },
        { id: 'admin_home',      title: '🔧 Admin Menu'        },
      ],
      env
    );
  }

  // Category: show category list, process selection in admin_edit_item_value
  if (msg.id === 'ef_category') {
    session.adminCtx.editField = 'category_id';
    session.state = 'admin_edit_item_value';
    await saveSession(phone, session, env);
    const cats = await getCategories(env);
    if (!cats.length) {
      return sendButtons(
        phone,
        '⚠️ No categories exist yet.',
        [{ id: 'admin_add_cat', title: '➕ Create Category' }],
        env
      );
    }
    const rows = cats.map(c => ({ id: `ecat_${c.id}`, title: c.name }));
    return sendList(
      phone,
      '📂 Choose a new *category*:',
      'Select Category',
      [{ title: 'Categories', rows }],
      env
    );
  }

  const field = fieldMap[msg.id];
  if (!field) {
    // User typed text instead of selecting from list — re-show field picker
    const item = await getMenuItem(session.adminCtx.editItemId, env);
    if (!item) return sendAdminError(phone, '⚠️ Item not found.', env);
    const availLabel = item.is_available ? '✅ Available' : '❌ Unavailable';
    return sendList(
      phone,
      `✏️ Editing *${item.name}*\nPlease tap a field to edit:\n\nSend *CANCEL* to abort.`,
      'Edit Field',
      [{
        title: 'Fields',
        rows: [
          { id: 'ef_name',         title: 'Name',         description: `Current: ${item.name.slice(0, 40)}` },
          { id: 'ef_price',        title: 'Price',        description: `Current: ₦${item.price.toFixed(2)}` },
          { id: 'ef_description',  title: 'Description',  description: `Current: ${(item.description || '(none)').slice(0, 40)}` },
          { id: 'ef_image_url',    title: 'Image URL',    description: `Current: ${(item.image_url || '(none)').slice(0, 40)}` },
          { id: 'ef_availability', title: 'Availability', description: `Currently ${availLabel}` },
          { id: 'ef_category',     title: 'Category',     description: 'Move to a different category' },
        ],
      }],
      env
    );
  }

  session.adminCtx.editField = field;
  session.state = 'admin_edit_item_value';
  await saveSession(phone, session, env);

  const prompts = {
    name:        'Enter the new *name*:\n\nSend *CANCEL* to abort.',
    price:       'Enter the new *price* (e.g. 1500):\n\nSend *CANCEL* to abort.',
    description: 'Enter the new *description*:\n\nSend *CANCEL* to abort.',
    image_url:   'Enter the new *image URL* (must start with https://):\n\nSend *CANCEL* to abort.',
  };
  return sendText(phone, prompts[field], env);
}

async function handleEditItemValue(phone, msg, session, env) {
  const { editItemId, editField } = session.adminCtx;

  if (!editItemId || !editField) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendAdminError(phone, '⚠️ Session lost. Please start over.', env);
  }

  // Category edit: handle list_reply from the category picker
  if (editField === 'category_id') {
    if (msg.id?.startsWith('ecat_')) {
      const catId = parseInt(msg.id.replace('ecat_', ''), 10);
      const cat = await getCategories(env).then(cats => cats.find(c => c.id === catId));
      if (!cat) return sendText(phone, '⚠️ Category not found. Please select again.', env);
      await updateMenuItem(editItemId, { category_id: catId }, env);
      await bustMenuCache(env);
      session.state    = 'admin_idle';
      session.adminCtx = {};
      await saveSession(phone, session, env);
      return sendButtons(
        phone,
        `✅ Category updated → *${cat.name}*`,
        [
          { id: 'admin_edit_item', title: '✏️ Edit Another' },
          { id: 'admin_home',      title: '🔧 Admin Menu'        },
        ],
        env
      );
    }
    // Invalid reply — re-show category list
    const cats = await getCategories(env);
    const rows = cats.map(c => ({ id: `ecat_${c.id}`, title: c.name }));
    return sendList(phone, '📂 Choose a new *category*:', 'Select Category', [{ title: 'Categories', rows }], env);
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
      [
        { id: 'admin_edit_item', title: '✏️ Edit Another' },
        { id: 'admin_home', title: '🔧 Admin Menu' },
      ],
      env
    );
  }

  let value = sanitize(msg.text || '', 500);

  if (editField === 'price') {
    // EDGE-21: validate with parsePrice — rejects non-numeric/zero/over-ceiling.
    const p = parsePrice(value);
    if (p === null) {
      return sendText(
        phone,
        '⚠️ Enter a valid price (e.g. 1500).\n\n' +
        `Price must be a number between 1 and ${formatPrice(MAX_PRICE)}.\n` +
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

  const displayVal = editField === 'price' ? formatPrice(value) : String(value).slice(0, 40);
  return sendButtons(
    phone,
    `✅ *${editField}* updated → ${displayVal}`,
    [
      { id: 'admin_edit_item', title: '✏️ Edit Another' },
      { id: 'admin_home',      title: '🔧 Admin Menu'        },
    ],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// Delete Item
// ─────────────────────────────────────────────────────────────

async function startDeleteFlow(phone, session, env) {
  session.adminCtx.pickerPage = 0;
  session.state = 'admin_delete_item_select';
  return showDeleteItemPicker(phone, session, env);
}

async function showDeleteItemPicker(phone, session, env) {
  return showItemPicker(phone, session, env, {
    prefix: 'del_', prevId: 'del_page_prev', nextId: 'del_page_next',
    body: '🗑️ *Delete Item*\nSelect item to delete:',
    btnLabel: 'Choose', sectionTitle: 'Items',
    descFor: i => `${formatPrice(i.price)}${i.is_available ? '' : ' (unavail)'}`,
  });
}

async function handleDeleteItemSelect(phone, msg, session, env) {
  // UX-11: pagination navigation.
  if (msg.id === 'del_page_next') {
    session.adminCtx.pickerPage = (session.adminCtx.pickerPage || 0) + 1;
    await saveSession(phone, session, env);
    return showDeleteItemPicker(phone, session, env);
  }
  if (msg.id === 'del_page_prev') {
    session.adminCtx.pickerPage = Math.max(0, (session.adminCtx.pickerPage || 0) - 1);
    await saveSession(phone, session, env);
    return showDeleteItemPicker(phone, session, env);
  }
  if (!msg.id?.startsWith('del_')) return showDeleteItemPicker(phone, session, env);

  const itemId = parseInt(msg.id.replace('del_', ''), 10);
  const item   = await getMenuItem(itemId, env);
  if (!item) return sendAdminError(phone, '⚠️ Item not found.', env);

  session.adminCtx.deleteItemId   = itemId;
  session.adminCtx.deleteItemName = item.name;
  session.state = 'admin_delete_item_confirm';
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `⚠️ Delete *${item.name}* (${formatPrice(item.price)})?\n\nThis cannot be undone.`,
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
      return sendAdminError(phone, '⚠️ Session lost. Please start over.', env);
    }

    // GAP (FK delete UX): deleteMenuItem returns { ok:false, reason:'in_use' }
    // when the item is still referenced by historical OrderItems instead of
    // throwing. Show a friendly message + an availability nudge rather than
    // silently failing or 500-ing the admin flow.
    const del = await deleteMenuItem(deleteItemId, env);
    if (!del.ok && del.reason === 'in_use') {
      session.state    = 'admin_idle';
      session.adminCtx = {};
      await saveSession(phone, session, env);
      return sendButtons(
        phone,
        `🚫 Can't delete *${deleteItemName}* — it appears in existing orders.\n\n` +
        'Mark it *unavailable* instead to hide it from customers while keeping order history intact.',
        [
          { id: 'admin_toggle_item', title: '🔄 Toggle Avail.' },
          { id: 'admin_home',        title: '🔧 Admin Menu'    },
        ],
        env
      );
    }
    await bustMenuCache(env);

    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `✅ *${deleteItemName}* deleted from menu.`,
      [
        { id: 'admin_delete_item', title: '🗑️ Delete Another' },
        { id: 'admin_home', title: '🔧 Admin Menu' },
      ],
      env
    );
  }

  session.state = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);
  return showAdminMenu(phone, env);
}

// ─────────────────────────────────────────────────────────────
// Toggle Availability
// ─────────────────────────────────────────────────────────────

async function startToggleFlow(phone, session, env) {
  session.adminCtx.pickerPage = 0;
  session.state = 'admin_toggle_item_select';
  return showToggleItemPicker(phone, session, env);
}

async function showToggleItemPicker(phone, session, env) {
  return showItemPicker(phone, session, env, {
    prefix: 'tog_', prevId: 'tog_page_prev', nextId: 'tog_page_next',
    body: '🔄 *Toggle Availability*\nTap an item to flip its status:',
    btnLabel: 'Choose Item', sectionTitle: 'All Items',
    descFor: i => (i.is_available ? '✅ Available' : '❌ Unavailable'),
  });
}

async function handleToggleItemSelect(phone, msg, session, env) {
  // UX-11: pagination navigation.
  if (msg.id === 'tog_page_next') {
    session.adminCtx.pickerPage = (session.adminCtx.pickerPage || 0) + 1;
    await saveSession(phone, session, env);
    return showToggleItemPicker(phone, session, env);
  }
  if (msg.id === 'tog_page_prev') {
    session.adminCtx.pickerPage = Math.max(0, (session.adminCtx.pickerPage || 0) - 1);
    await saveSession(phone, session, env);
    return showToggleItemPicker(phone, session, env);
  }
  if (!msg.id?.startsWith('tog_')) return showToggleItemPicker(phone, session, env);

  const itemId = parseInt(msg.id.replace('tog_', ''), 10);
  const item   = await env.DB.prepare(
    'SELECT id, name, is_available FROM MenuItems WHERE id = ?'
  ).bind(itemId).first();

  if (!item) return sendAdminError(phone, '⚠️ Item not found.', env);

  const newAvail = item.is_available ? 0 : 1;
  await env.DB.prepare('UPDATE MenuItems SET is_available = ? WHERE id = ?')
    .bind(newAvail, itemId)
    .run();
  await bustMenuCache(env);

  const label = newAvail ? '✅ Available' : '❌ Unavailable';
  return sendButtons(
    phone,
    `*${item.name}* is now *${label}*.`,
    [
      { id: 'admin_toggle_item', title: '🔄 Toggle Another' },
      { id: 'admin_home', title: '🔧 Admin Menu' },
    ],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// View Orders
// ─────────────────────────────────────────────────────────────

// UX-10: paginate the order-status update list. Page size 8 plus up to two
// nav rows and one typed-ID fallback row — the order count is trimmed so the
// total never exceeds WhatsApp's 10-row cap (no orders are silently lost).
const ORDERS_PAGE_SIZE = 8;

async function viewOrders(phone, session, env) {
  const page   = Math.max(0, session.adminCtx.ordersPage || 0);
  const offset = page * ORDERS_PAGE_SIZE;
  const { orders, total } = await getActiveOrdersPaginated(env, ORDERS_PAGE_SIZE, offset);

  if (!orders.length && page === 0) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '📭 No pending orders right now.',
      [{ id: 'admin_home', title: '🔧 Admin Menu' }],
      env
    );
  }

  // If we paged past the end (e.g. orders cleared), step back to the last page.
  if (!orders.length && page > 0) {
    session.adminCtx.ordersPage = page - 1;
    await saveSession(phone, session, env);
    return viewOrders(phone, session, env);
  }

  const hasPrev = page > 0;
  const hasNext = offset + ORDERS_PAGE_SIZE < total;

  // Show ALL fetched orders — never trim them (orders must not be silently lost).
  const rows = orders.map(o => ({
    id: `astat_${o.id}`,
    title: `#${o.id} - ${o.status.toUpperCase()} (${formatPrice(o.total_price)})`,
    description: `💳 ${o.payment_status.toUpperCase()} | 📱 ${o.user_phone} | 📍 ${(o.address || '').slice(0, 20)}`
  }));

  if (hasPrev) rows.push({ id: 'orders_page_prev', title: '⬅️ Prev Page' });
  if (hasNext) rows.push({ id: 'orders_page_next', title: '➡️ Next Page' });
  // UX-12: typed-numeric-ID fallback row — only when it fits within the 10-row cap.
  if (rows.length < 10) {
    rows.push({ id: 'admin_update_status_id', title: '⌨️ Type Order ID', description: 'Enter an order ID manually' });
  }

  const totalPages = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));

  session.state = 'admin_orders_list';
  await saveSession(phone, session, env);

  return sendList(
    phone,
    `📦 *Active Orders* — Page ${page + 1} of ${totalPages}\nSelect an order to update its status:`,
    'Select Order',
    [{ title: 'Pending/Active', rows }],
    env
  );
}

async function handleAdminOrdersList(phone, msg, session, env) {
  // UX-10: pagination navigation.
  if (msg.id === 'orders_page_next') {
    session.adminCtx.ordersPage = (session.adminCtx.ordersPage || 0) + 1;
    await saveSession(phone, session, env);
    return viewOrders(phone, session, env);
  }
  if (msg.id === 'orders_page_prev') {
    session.adminCtx.ordersPage = Math.max(0, (session.adminCtx.ordersPage || 0) - 1);
    await saveSession(phone, session, env);
    return viewOrders(phone, session, env);
  }

  if (msg.type === 'list_reply' && msg.id?.startsWith('astat_')) {
    const orderId = parseInt(msg.id.replace('astat_', ''), 10);
    const order = await getOrder(orderId, env);
    if (!order) return viewOrders(phone, session, env);

    session.adminCtx.updateOrderId = orderId;
    session.adminCtx.orderPhone    = order.user_phone;
    session.adminCtx.orderCurrentStatus = order.status;
    session.adminCtx.orderPaymentStatus = order.payment_status;
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

  // UX-12: typed-numeric-ID fallback.
  if (msg.id === 'admin_update_status_id' || msg.id === 'admin_update_status') {
    session.state = 'admin_update_status_id';
    await saveSession(phone, session, env);
    return sendText(phone, '📦 Enter the *Order ID* to update:\n\nSend *CANCEL* to abort.', env);
  }

  session.state    = 'admin_idle';
  session.adminCtx = {};
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
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      '❌ Status update cancelled.',
      [
        { id: 'admin_update_status', title: '📦 Update Status' },
        { id: 'admin_home', title: '🔧 Admin Menu' },
      ],
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
  session.adminCtx.orderCurrentStatus = order.status;
  session.adminCtx.orderPaymentStatus = order.payment_status;
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
  const orderId = session.adminCtx.updateOrderId;
  const current = session.adminCtx.orderCurrentStatus;

  // EDGE-11: re-render the status list instead of stranding the admin with text.
  if (!msg.id?.startsWith('status_') || !VALID_STATUSES.includes(msg.id.replace('status_', ''))) {
    if (!orderId) {
      session.state = 'admin_idle';
      await saveSession(phone, session, env);
      return showAdminMenu(phone, env);
    }
    const rows = VALID_STATUSES.map(s => ({ id: `status_${s}`, title: s.toUpperCase() }));
    return sendList(
      phone,
      `📦 *Order #${orderId}*\nPlease tap a status from the list:`,
      'Choose Status',
      [{ title: 'Order Statuses', rows }],
      env
    );
  }

  const newStatus = msg.id.replace('status_', '');

  // EDGE-07: skip work (and the customer notification) when nothing changes.
  if (current && newStatus === current) {
    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `ℹ️ Order #${orderId} is already *${newStatus.toUpperCase()}* — no change made.`,
      [
        { id: 'admin_update_status', title: '📦 Update Status' },
        { id: 'admin_home',          title: '🔧 Admin Menu'   },
      ],
      env
    );
  }

  // EDGE-07: reject illegal transitions (delivered & cancelled are terminal).
  if (current && !isAllowedTransition(current, newStatus)) {
    return sendButtons(
      phone,
      `🚫 Cannot change order #${orderId} from *${current.toUpperCase()}* to *${newStatus.toUpperCase()}*.\n\n` +
      'Delivered and cancelled orders are final.',
      [
        { id: 'admin_view_orders', title: '📦 View Orders' },
        { id: 'admin_home',        title: '🔧 Admin Menu' },
      ],
      env
    );
  }

  session.adminCtx.newStatus = newStatus;

  // Ask for confirmation for destructive or final statuses
  if (newStatus === 'cancelled' || newStatus === 'delivered') {
    session.state = 'admin_update_status_confirm';
    await saveSession(phone, session, env);

    // EDGE-08: warn the admin when cancelling a PAID order — manual refund needed.
    let warn = '';
    if (newStatus === 'cancelled' && session.adminCtx.orderPaymentStatus === 'paid') {
      warn = '\n\n⚠️ This order is PAID — a manual refund is required.';
      console.warn(`[Admin] Cancelling PAID order #${orderId} — manual refund required.`);
    }

    return sendButtons(
      phone,
      `⚠️ *Confirm Status Change*\n\nAre you sure you want to mark order #${orderId} as *${newStatus.toUpperCase()}*?${warn}`,
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
  const { updateOrderId, orderPhone, newStatus, orderCurrentStatus, orderPaymentStatus } = session.adminCtx;
  if (!updateOrderId || !orderPhone || !newStatus) {
    session.state = 'admin_idle';
    await saveSession(phone, session, env);
    return sendAdminError(phone, '⚠️ Session lost. Please start over.', env);
  }

  // EDGE-07: re-check for no-op / illegal transition before writing.
  if (orderCurrentStatus && newStatus === orderCurrentStatus) {
    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `ℹ️ Order #${updateOrderId} is already *${newStatus.toUpperCase()}* — no change made.`,
      [
        { id: 'admin_update_status', title: '📦 Update Status' },
        { id: 'admin_home',          title: '🔧 Admin Menu'   },
      ],
      env
    );
  }
  if (orderCurrentStatus && !isAllowedTransition(orderCurrentStatus, newStatus)) {
    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `🚫 Cannot change order #${updateOrderId} from *${orderCurrentStatus.toUpperCase()}* to *${newStatus.toUpperCase()}*.`,
      [{ id: 'admin_home', title: '🔧 Admin Menu' }],
      env
    );
  }

  await updateOrderStatus(updateOrderId, newStatus, env);

  // GAP (automated refund): a paid order being cancelled triggers an automatic
  // Flutterwave refund attempt (was warn-only). Fetch the order so we have the
  // persisted transaction id; every step degrades gracefully.
  const paidCancel = newStatus === 'cancelled' && orderPaymentStatus === 'paid';
  let refundLine = '';
  if (paidCancel) {
    console.warn(`[Admin] Order #${updateOrderId} cancelled while PAID — attempting refund.`);
    const order = await getOrder(updateOrderId, env);
    refundLine = await attemptPaidCancelRefund(order || { id: updateOrderId, total_price: null }, env);
  }

  // UX-09: notify the customer and only claim success when the send resolves.
  const notified = await notifyCustomerStatus(orderPhone, updateOrderId, newStatus, env);

  const notifyLine = notified
    ? '✅ Customer notified.'
    : "⚠️ Could not reach the customer (they'll see status next visit).";

  session.state    = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `✅ Order #${updateOrderId} status updated to *${newStatus.toUpperCase()}*.\n\n${notifyLine}${refundLine}`,
    [
      { id: 'admin_update_status', title: '📦 Update Status' },
      { id: 'admin_home', title: '🔧 Admin Menu' },
    ],
    env
  );
}

/**
 * UX-09: send a proactive order-status update to the customer.
 * Prefers a configured WhatsApp template (ORDER_STATUS_TEMPLATE) for the
 * proactive send, falling back to plain text. Returns true only when the
 * send actually resolves so callers can report honestly.
 */
async function notifyCustomerStatus(orderPhone, orderId, newStatus, env) {
  try {
    const tpl = env.ORDER_STATUS_TEMPLATE;
    if (tpl) {
      const lang = env.ORDER_STATUS_TEMPLATE_LANG || 'en';
      const components = [{
        type: 'body',
        parameters: [
          { type: 'text', text: String(orderId) },
          { type: 'text', text: newStatus.toUpperCase() },
        ],
      }];
      await sendTemplate(orderPhone, tpl, lang, components, env);
    } else {
      await sendText(orderPhone, statusMessage(orderId, newStatus), env);
    }
    return true;
  } catch (err) {
    console.error('[Admin] Failed to notify customer of status change:', err);
    return false;
  }
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

/**
 * GAP (automated refund): when a PAID order is cancelled we now attempt a
 * Flutterwave refund automatically instead of merely warning. The transaction
 * id was persisted to the order's payment_access_code column at payment time
 * (db.persistTransactionId). Every step is best-effort and degrades gracefully:
 *
 *   • no tx id        → log a refund row with status 'manual' + alert the admin
 *   • refund attempted → log the result + alert the admin to verify
 *   • refund throws    → log status 'error' + alert; never breaks the cancel
 *
 * Returns a short human line summarising the outcome for the admin reply.
 */
async function attemptPaidCancelRefund(order, env) {
  const orderId = order?.id;
  const txId = order?.payment_access_code;
  const amount = order?.total_price ?? null;

  // No persisted transaction id — we cannot auto-refund. Record + alert so a
  // human can refund manually; don't pretend it happened.
  if (!txId) {
    await logRefund(env, { orderId, txId: null, amount, status: 'manual' });
    await alertAdmin(env, 'paid_cancel_no_txid',
      `Order #${orderId} cancelled while PAID but has no transaction id — manual refund required (₦${amount ?? '?'}).`);
    return '\n⚠️ This order is PAID but no transaction id is on file — *manual refund required*.';
  }

  try {
    const result = await refundFlutterwaveTransaction(txId, env, amount);
    const ok = result && (result.status === 'success' || result.ok === true);
    await logRefund(env, { orderId, txId, amount, status: ok ? 'refunded' : 'requested' });
    await alertAdmin(env, 'paid_cancel_refund',
      `Order #${orderId} (₦${amount ?? '?'}) refund ${ok ? 'succeeded' : 'requested'} via tx ${txId}.`);
    return ok
      ? '\n💸 Refund issued automatically — customer will be credited.'
      : '\n💸 Refund requested — please verify it completed on Flutterwave.';
  } catch (err) {
    await logRefund(env, { orderId, txId, amount, status: 'error' });
    await alertAdmin(env, 'paid_cancel_refund_failed',
      `Order #${orderId} auto-refund FAILED (tx ${txId}): ${err && err.message}`);
    return '\n⚠️ Automatic refund FAILED — *manual refund required* (admin alerted).';
  }
}

// ─────────────────────────────────────────────────────────────
// Bulk Actions — Multi-step paginated flow
// ─────────────────────────────────────────────────────────────

async function showBulkMenu(phone, session, env) {
  session.state = 'admin_bulk_menu';
  session.adminCtx.bulk = {};
  await saveSession(phone, session, env);

  return sendList(
    phone,
    '🏗️ *Bulk Actions*\nChoose an action to perform on multiple records:',
    'Choose Action',
    [
      {
        title: 'Menu Items',
        rows: [
          { id: 'bulk_items_add',    title: '➕ Add Items',       description: 'Paste multiple items at once' },
          { id: 'bulk_items_remove', title: '🗑️ Remove Items',    description: 'Delete multiple items' },
          { id: 'bulk_items_edit',   title: '✏️ Edit Items',      description: 'Price, category, availability…' },
        ],
      },
      {
        title: 'Categories',
        rows: [
          { id: 'bulk_cats_add',    title: '📂 Add Categories', description: 'Create multiple categories' },
          { id: 'bulk_cats_rename', title: '✏️ Rename Category', description: 'Change a category name' },
          { id: 'bulk_cats_delete', title: '🗑️ Delete Category', description: 'Remove with item safety' },
          { id: 'bulk_cats_move',   title: '🔀 Move Items',      description: 'Move items between categories' },
        ],
      },
      {
        title: 'Orders',
        rows: [
          { id: 'bulk_orders', title: '📦 Update Status', description: 'Set status on multiple orders' },
        ],
      },
    ],
    env
  );
}

async function handleBulkMenu(phone, msg, session, env) {
  const id = msg.id;

  // ── Items: Add ──────────────────────────────────────────────
  if (id === 'bulk_items_add') {
    // UX-14: offer a category dropdown before forcing typed category names.
    session.state = 'admin_bulk_items_add_category';
    session.adminCtx.bulk = { type: 'menu_items', action: 'add' };
    await saveSession(phone, session, env);
    return showBulkAddCategoryStep(phone, session, env);
  }

  // ── Items: Remove ────────────────────────────────────────────
  if (id === 'bulk_items_remove') {
    session.state = 'admin_bulk_items_remove_select';
    session.adminCtx.bulk = { type: 'menu_items', action: 'remove', selectedIds: [], page: 0 };
    await resetSelection(phone, env); // GAP: seed the dedicated selection key
    await saveSession(phone, session, env);
    return showBulkItemsRemoveList(phone, session, env);
  }

  // ── Items: Edit ──────────────────────────────────────────────
  if (id === 'bulk_items_edit') {
    session.state = 'admin_bulk_items_edit_action';
    session.adminCtx.bulk = { type: 'menu_items', action: 'edit', selectedIds: [], page: 0 };
    await resetSelection(phone, env); // GAP: seed the dedicated selection key
    await saveSession(phone, session, env);
    return showBulkItemsEditActionMenu(phone, env);
  }

  // ── Legacy: availability-only shortcut ───────────────────────
  if (id === 'bulk_items') {
    session.state = 'admin_bulk_items_action';
    session.adminCtx.bulk = { type: 'menu_items', selectedIds: [], page: 0 };
    await resetSelection(phone, env); // GAP: seed the dedicated selection key
    await saveSession(phone, session, env);
    return sendButtons(phone, '🍽️ *Bulk Menu*\nWhat do you want to do?',
      [{ id: 'ba_mi_avail', title: 'Mark Available' }, { id: 'ba_mi_unavail', title: 'Mark Unavail.' }, { id: 'admin_home', title: '❌ Cancel' }], env);
  }

  // ── Categories ───────────────────────────────────────────────
  if (id === 'bulk_cats_add') {
    session.state = 'admin_bulk_cats_add_paste';
    session.adminCtx.bulk = { type: 'categories', action: 'add' };
    await saveSession(phone, session, env);
    return showBulkCatAddTemplate(phone, env);
  }
  if (id === 'bulk_cats_rename') {
    session.state = 'admin_bulk_cats_rename_select';
    session.adminCtx.bulk = { type: 'categories', action: 'rename' };
    await saveSession(phone, session, env);
    return showBulkCatsRenameList(phone, env);
  }
  if (id === 'bulk_cats_delete') {
    session.state = 'admin_bulk_cats_delete_select';
    session.adminCtx.bulk = { type: 'categories', action: 'delete', selectedIds: [] };
    await resetSelection(phone, env); // GAP: seed the dedicated selection key
    await saveSession(phone, session, env);
    return showBulkCatsDeleteList(phone, session, env);
  }
  if (id === 'bulk_cats_move') {
    session.state = 'admin_bulk_cats_move_source';
    session.adminCtx.bulk = { type: 'categories', action: 'move' };
    await saveSession(phone, session, env);
    return showBulkCatsMoveSourceList(phone, env);
  }

  // ── Orders ────────────────────────────────────────────────────
  if (id === 'bulk_orders') {
    session.state = 'admin_bulk_orders_action';
    session.adminCtx.bulk = { type: 'orders', selectedIds: [], page: 0 };
    await saveSession(phone, session, env);
    const rows = VALID_STATUSES.map(s => ({ id: `ba_os_${s}`, title: s.toUpperCase() }));
    return sendList(phone, '📦 *Bulk Orders*\nWhich status to apply?', 'Choose Status', [{ title: 'Statuses', rows }], env);
  }

  // ── admin_bulk_menu re-entry button ───────────────────────────
  if (id === 'admin_bulk_menu') return showBulkMenu(phone, session, env);

  return showBulkMenu(phone, session, env);
}

// Stub dispatcher: used by existing handleAdminIdle for admin_bulk_menu button
// (already handled above — kept for clarity)
async function handleBulkCatsType(phone, msg, session, env) {
  return showBulkMenu(phone, session, env);
}

async function handleBulkOrdersAction(phone, msg, session, env) {
  if (!msg.id?.startsWith('ba_os_')) return handleBulkMenu(phone, { id: 'bulk_orders' }, session, env);

  const status = msg.id.replace('ba_os_', '');
  session.adminCtx.bulk.action = 'set_status';
  session.adminCtx.bulk.targetValue = status;
  session.adminCtx.bulk.selectedIds = [];
  session.state = 'admin_bulk_orders_select';
  await resetSelection(phone, env); // GAP: seed the dedicated selection key
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

  if (bulk.page > 0) {
    rows.push({ id: 'bulk_page_prev', title: '⬅️ Prev Page', description: `Show orders ${offset - pageSize + 1}-${offset}` });
  }
  if (offset + pageSize < total) {
    rows.push({ id: 'bulk_page_next', title: '➡️ Next Page', description: `Show orders ${offset + pageSize + 1}-${Math.min(offset + pageSize * 2, total)}` });
  }
  rows.push({ id: 'bulk_review', title: `✅ Done (${bulk.selectedIds.length} sel.)`, description: 'Review & apply status' });

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
    await toggleSelection(phone, bulk, orderId, env); // GAP: KV read-modify-write, race-safe
    await saveSession(phone, session, env);
    return showBulkOrdersList(phone, session, env);
  }

  // Handle buttons
  if (msg.id === 'bulk_review' || (msg.text || '').toUpperCase() === 'REVIEW') {
    await loadSelection(phone, bulk, env); // GAP: re-read authoritative selection at commit
    if (!bulk.selectedIds.length) {
      return sendText(phone, '⚠️ Please select at least one order first.', env);
    }

    let body = `📝 *Bulk Review*\n\nAction: *${bulk.targetValue.toUpperCase()}*\nTarget: ${bulk.selectedIds.length} orders (#${bulk.selectedIds.join(', #')})\n\n`;

    // UX-16: offer a canned reason list when cancelling, instead of free text.
    if (bulk.targetValue === 'cancelled') {
      session.state = 'admin_bulk_orders_reason';
      await saveSession(phone, session, env);
      return showBulkCancelReasonList(phone, env);
    }

    session.state = 'admin_bulk_orders_confirm';
    await saveSession(phone, session, env);
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

// UX-16 / EDGE-17: canned bulk-cancel reason list.
async function showBulkCancelReasonList(phone, env) {
  return sendList(
    phone,
    '❓ *Why are these orders being cancelled?*\nPick a reason (it will be shown to the customer):',
    'Choose Reason',
    [{
      title: 'Reasons',
      rows: [
        { id: 'ba_reason_out_of_stock', title: 'Out of stock',    description: 'Items are unavailable' },
        { id: 'ba_reason_closed',       title: 'We are closed',    description: 'Outside opening hours' },
        { id: 'ba_reason_unreachable',  title: 'Could not reach',  description: 'Customer unreachable' },
        { id: 'ba_reason_payment',      title: 'Payment problem',  description: 'Payment issue' },
        { id: 'ba_reason_other',        title: 'Other (type it)',  description: 'Enter a custom reason' },
        { id: 'ba_reason_skip',         title: 'Skip / no reason', description: 'Cancel without a reason' },
      ],
    }],
    env
  );
}

async function handleBulkOrdersReason(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  // Awaiting a custom "Other" reason as free text.
  if (bulk.awaitingCustomReason) {
    if (msg.text && msg.text.trim()) {
      bulk.cancellationReason = sanitize(msg.text, 200);
      bulk.awaitingCustomReason = false;
      return promptBulkCancelNotify(phone, session, env);
    }
    return sendText(phone, '❓ Please type the cancellation reason, or send *CANCEL* to abort.', env);
  }

  if (msg.id === 'ba_reason_other') {
    bulk.awaitingCustomReason = true;
    await saveSession(phone, session, env);
    return sendText(phone, '✍️ Type the cancellation reason to show the customer:\n\nSend *CANCEL* to abort.', env);
  }

  if (msg.id === 'ba_reason_skip') {
    bulk.cancellationReason = '';
    return promptBulkCancelNotify(phone, session, env);
  }

  if (msg.id?.startsWith('ba_reason_')) {
    const code = msg.id.replace('ba_reason_', '');
    const sentence = BULK_CANCEL_REASONS[code];
    if (sentence) {
      bulk.cancellationReason = sentence;
      return promptBulkCancelNotify(phone, session, env);
    }
  }

  // EDGE-17: unexpected input — re-prompt instead of silently aborting.
  return showBulkCancelReasonList(phone, env);
}

async function promptBulkCancelNotify(phone, session, env) {
  const { bulk } = session.adminCtx;
  session.state = 'admin_bulk_orders_confirm';
  await saveSession(phone, session, env);
  const reasonLine = bulk.cancellationReason ? `Reason: ${bulk.cancellationReason}\n` : 'Reason: (none)\n';
  return sendButtons(
    phone,
    `Action: *CANCEL*\n${reasonLine}Target: ${bulk.selectedIds.length} orders\n\nNotify customers?`,
    [
      { id: 'bulk_confirm_notify', title: '✅ Yes, Notify' },
      { id: 'bulk_confirm_silent', title: '🤫 No, Silent' },
      { id: 'admin_back', title: '⬅️ Back' }
    ],
    env
  );
}

async function handleBulkOrdersConfirm(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  // EDGE-20: BACK returns to the order-selection list instead of dead-ending.
  if (msg.id === 'admin_back' || (msg.text || '').toUpperCase() === 'BACK') {
    session.state = 'admin_bulk_orders_select';
    await saveSession(phone, session, env);
    return showBulkOrdersList(phone, session, env);
  }

  if (msg.id === 'bulk_confirm_notify' || msg.id === 'bulk_confirm_silent') {
    bulk.notifyCustomers = (msg.id === 'bulk_confirm_notify');
    return executeBulkOrders(phone, session, env);
  }

  // Unexpected input — re-prompt rather than silently aborting.
  return sendButtons(
    phone,
    `Action: *${bulk.targetValue.toUpperCase()}*\nTarget: ${bulk.selectedIds.length} orders\n\nNotify customers?`,
    [
      { id: 'bulk_confirm_notify', title: '✅ Yes, Notify' },
      { id: 'bulk_confirm_silent', title: '🤫 No, Silent' },
      { id: 'admin_back', title: '⬅️ Back' }
    ],
    env
  );
}

async function executeBulkOrders(phone, session, env) {
  const { bulk } = session.adminCtx;
  const status = bulk.targetValue;
  await loadSelection(phone, bulk, env); // GAP: re-read authoritative selection before writing

  let successCount = 0;
  let skippedCount = 0;
  let failureCount = 0;
  let paidCancelCount = 0;
  const failureDetails = [];

  // GAP (N+1): fetch every selected order in ONE query instead of getOrder()
  // per id (which also issued a second query for items we never use here). Only
  // the columns the loop needs are selected; payment_access_code carries the
  // persisted Flutterwave transaction id for the auto-refund path.
  const orderMap = new Map();
  if (bulk.selectedIds.length) {
    const placeholders = bulk.selectedIds.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id, user_phone, total_price, status, payment_status, payment_access_code
       FROM Orders WHERE id IN (${placeholders})`
    ).bind(...bulk.selectedIds).all();
    for (const row of rows.results) orderMap.set(row.id, row);
  }

  for (const id of bulk.selectedIds) {
    try {
      const order = orderMap.get(id);
      if (!order) {
        skippedCount++;
        continue;
      }

      // EDGE-07: skip no-op and illegal transitions (delivered & cancelled are terminal).
      if (order.status === status) {
        skippedCount++;
        continue;
      }
      if (!isAllowedTransition(order.status, status)) {
        skippedCount++;
        continue;
      }

      // Decision #4: unpaid (Flutterwave) orders excluded from kitchen statuses by default
      const isKitchenStatus = ['confirmed', 'preparing', 'ready'].includes(status);
      if (isKitchenStatus && order.payment_status !== 'paid') {
        skippedCount++;
        continue;
      }

      await updateOrderStatus(id, status, env);
      successCount++;

      // GAP (automated refund): a paid order being cancelled triggers an
      // automatic Flutterwave refund attempt (was warn-only). Best-effort —
      // attemptPaidCancelRefund never throws on the refund itself.
      if (status === 'cancelled' && order.payment_status === 'paid') {
        paidCancelCount++;
        await attemptPaidCancelRefund(order, env);
      }

      if (bulk.notifyCustomers) {
        let custMsg = statusMessage(id, status);
        if (status === 'cancelled' && bulk.cancellationReason) {
          custMsg = `❌ Order #${id} cancelled.\nReason: ${bulk.cancellationReason}\n\nIf you already paid, our team will contact you about refund/support.`;
        }
        // UX-09: best-effort; never let a failed notify abort the batch.
        await sendText(order.user_phone, custMsg, env).catch(
          err => console.error(`[Admin] Bulk notify failed for #${id}:`, err)
        );
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

  // GAP (automated refund): surface that paid cancellations triggered auto-refunds.
  const paidWarn = paidCancelCount > 0
    ? `\n💸 ${paidCancelCount} PAID order(s) cancelled — auto-refund attempted (admin alerted to verify).`
    : '';

  const summary =
    `✅ *Bulk Action Complete*\n\n` +
    `Action: *${status.toUpperCase()}*\n` +
    `Updated: ${successCount}\n` +
    `Skipped: ${skippedCount}\n` +
    `Failed: ${failureCount}\n` +
    `Notified: ${bulk.notifyCustomers ? successCount : 0}${paidWarn}\n\n` +
    `Log ID: ${logId}`;

  return sendButtons(
    phone,
    summary,
    [
      { id: 'admin_bulk_menu', title: '📦 Bulk Actions' },
      { id: 'admin_home', title: '🔧 Admin Menu' },
    ],
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
    await toggleSelection(phone, bulk, itemId, env); // GAP: KV read-modify-write, race-safe
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
    await loadSelection(phone, bulk, env); // GAP: re-read authoritative selection before writing

    try {
      await bulkUpdateMenuAvailability(bulk.selectedIds, isAvail, env);
      await bustMenuCache(env);

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
        [
          { id: 'admin_bulk_menu', title: '📦 Bulk Actions' },
          { id: 'admin_home', title: '🔧 Admin Menu' },
        ],
        env
      );
    } catch (err) {
      console.error('[Admin] Bulk item update failed:', err);
      return sendAdminError(phone, '⚠️ Failed to complete bulk update. Please try again.', env);
    }
  }

  return showBulkItemsList(phone, session, env);
}

// ─────────────────────────────────────────────────────────────
// Bulk Parser Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Parse a bulk item paste.
 *
 * UX-14: when `forcedCategory` is provided (admin picked one from a dropdown),
 * the per-line category column is dropped — columns become
 *   Name | Price | Description | Image URL | Available
 * Otherwise the legacy column layout with an inline category is used.
 *
 * EDGE-21: prices are validated with parsePrice (rejects zero/over-ceiling).
 */
function parseBulkItemPaste(rawText, categories, existingNames, forcedCategory = null) {
  const catByName = {};
  for (const c of categories) catByName[c.name.toLowerCase()] = c;
  const existingLower = new Set((existingNames || []).map(n => n.toLowerCase()));
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const valid = [];
  const errors = [];
  const seenNames = new Set();

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split('|').map(p => p.trim());
    const lineNum = i + 1;
    const rowErrors = [];
    const name = sanitize(parts[0] || '', 100);

    // Shift the column indices when the category comes from the dropdown.
    const categoryRaw = forcedCategory ? '' : (parts[1] || '');
    const priceRaw    = forcedCategory ? (parts[1] || '') : (parts[2] || '');
    const description = sanitize((forcedCategory ? parts[2] : parts[3]) || '', 300);
    const imageUrl    = ((forcedCategory ? parts[3] : parts[4]) || '').trim();
    const availableRaw = ((forcedCategory ? parts[4] : parts[5]) || 'yes').trim().toLowerCase();

    const cat = forcedCategory || catByName[categoryRaw.toLowerCase()];

    if (name.length < 2) rowErrors.push('name must be ≥2 chars');
    if (!forcedCategory) {
      if (!categoryRaw) rowErrors.push('category required');
      else if (!cat) rowErrors.push(`category "${categoryRaw.slice(0, 20)}" not found`);
    }
    // EDGE-21: parsePrice rejects non-numeric, zero, negative and over-ceiling.
    const price = parsePrice(priceRaw);
    if (!priceRaw) rowErrors.push('price required');
    else if (price === null) rowErrors.push('invalid price (1–' + MAX_PRICE + ')');
    if (imageUrl && !isValidHttpsUrl(imageUrl)) rowErrors.push('image URL must be https://');
    if (name.length >= 2 && existingLower.has(name.toLowerCase())) rowErrors.push('already exists in menu');
    if (name.length >= 2 && seenNames.has(name.toLowerCase())) rowErrors.push('duplicate in paste');
    seenNames.add(name.toLowerCase());

    const isAvailable = !['no', 'false', '0', 'unavailable'].includes(availableRaw);
    if (rowErrors.length > 0) {
      errors.push({ line: lineNum, text: lines[i].slice(0, 50), reasons: rowErrors });
    } else {
      valid.push({ name, categoryId: cat.id, categoryName: cat.name, price, description, imageUrl, isAvailable });
    }
  }
  return { valid, errors, total: lines.length };
}

function parseBulkCategoryPaste(rawText, existingCategories) {
  const existingLower = new Set(existingCategories.map(c => c.name.toLowerCase()));
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const valid = [];
  const errors = [];
  const seenNames = new Set();

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split('|').map(p => p.trim());
    const lineNum = i + 1;
    const rowErrors = [];
    const name = sanitize(parts[0] || '', 50);
    const sortOrderRaw = parts[1] ? parts[1].trim() : '';
    const sortOrder = sortOrderRaw ? parseInt(sortOrderRaw, 10) : 0;

    if (name.length < 2) rowErrors.push('name must be ≥2 chars');
    if (sortOrderRaw && isNaN(sortOrder)) rowErrors.push('sort order must be a number');
    if (name.length >= 2 && existingLower.has(name.toLowerCase())) rowErrors.push('already exists');
    if (name.length >= 2 && seenNames.has(name.toLowerCase())) rowErrors.push('duplicate in paste');
    seenNames.add(name.toLowerCase());

    if (rowErrors.length > 0) {
      errors.push({ line: lineNum, text: lines[i].slice(0, 50), reasons: rowErrors });
    } else {
      valid.push({ name, sortOrder: isNaN(sortOrder) ? 0 : sortOrder });
    }
  }
  return { valid, errors, total: lines.length };
}

// ─────────────────────────────────────────────────────────────
// Bulk Items — Add (paste flow)
// ─────────────────────────────────────────────────────────────

// UX-14: category dropdown step. Picking one drops the per-line category
// column; "Per-line category" keeps the legacy typed-category format.
async function showBulkAddCategoryStep(phone, session, env) {
  const cats = await getCategories(env);
  if (!cats.length) {
    // EDGE-11: no categories — give the admin a way forward, don't strand.
    return sendButtons(
      phone,
      '⚠️ No categories exist yet. Create one before bulk-adding items.',
      [
        { id: 'admin_add_cat',   title: '➕ Add Category' },
        { id: 'admin_bulk_menu', title: '📦 Bulk Actions' },
      ],
      env
    );
  }
  // Cap at 8 categories to leave room for the "Per-line" row within the 10-row cap.
  const rows = cats.slice(0, 8).map(c => ({ id: `bac_${c.id}`, title: c.name }));
  rows.push({ id: 'bac_per_line', title: '✍️ Per-line category', description: 'Type the category on each line' });
  return sendList(
    phone,
    '📂 *Bulk Add Items*\nChoose ONE category for all pasted items, or pick per-line:',
    'Choose Category',
    [{ title: 'Categories', rows }],
    env
  );
}

async function handleBulkItemsAddCategory(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id === 'bac_per_line') {
    bulk.forcedCategoryId = null;
    bulk.forcedCategoryName = null;
    session.state = 'admin_bulk_items_add_paste';
    await saveSession(phone, session, env);
    return showBulkItemAddTemplate(phone, session, env);
  }

  if (msg.id?.startsWith('bac_')) {
    const catId = parseInt(msg.id.replace('bac_', ''), 10);
    const cat = await getCategoryById(catId, env);
    if (!cat) return showBulkAddCategoryStep(phone, session, env);
    bulk.forcedCategoryId = catId;
    bulk.forcedCategoryName = cat.name;
    session.state = 'admin_bulk_items_add_paste';
    await saveSession(phone, session, env);
    return showBulkItemAddTemplate(phone, session, env);
  }

  // Unexpected input — re-show the dropdown.
  return showBulkAddCategoryStep(phone, session, env);
}

async function showBulkItemAddTemplate(phone, session, env) {
  // UX-14: when a category was picked, hide the category column from the format.
  const forced = session?.adminCtx?.bulk?.forcedCategoryName;
  if (forced) {
    return sendText(
      phone,
      '📋 *Bulk Add Items*\n\n' +
      `Category: *${forced}* (applies to every line)\n\n` +
      'Paste items below, one per line:\n' +
      '*Format:* Name | Price | Description | Image URL | Available\n\n' +
      '*Examples:*\n' +
      'Jollof Rice | 1500 | Rich tomato rice\n' +
      'Fried Chicken | 2000 | Crispy | | no\n' +
      'Suya | 800\n\n' +
      '*Rules:*\n' +
      '• Name is required (≥2 chars)\n' +
      '• Price: number (e.g. 850 or 1200.50)\n' +
      '• Available: yes/no (default: yes)\n' +
      '• Image URL must start with https://\n\n' +
      'Send *CANCEL* to abort.',
      env
    );
  }
  return showBulkItemAddTemplateLegacy(phone, env);
}

async function showBulkItemAddTemplateLegacy(phone, env) {
  return sendText(
    phone,
    '📋 *Bulk Add Items*\n\n' +
    'Paste items below, one per line:\n' +
    '*Format:* Name | Category | Price | Description | Image URL | Available\n\n' +
    '*Examples:*\n' +
    'Jollof Rice | Main Dishes | 1500 | Rich tomato rice\n' +
    'Fried Chicken | Main | 2000 | Crispy | | no\n' +
    'Suya | Grills | 800\n\n' +
    '*Rules:*\n' +
    '• Name & Category are required\n' +
    '• Category must already exist\n' +
    '• Price: number (e.g. 850 or 1200.50)\n' +
    '• Available: yes/no (default: yes)\n' +
    '• Image URL must start with https://\n\n' +
    'Send *CANCEL* to abort.',
    env
  );
}

async function handleBulkItemsAddPaste(phone, msg, session, env) {
  if (!msg.text || msg.type === 'button_reply' || msg.type === 'list_reply') {
    return showBulkItemAddTemplate(phone, session, env);
  }
  const rawText = msg.text.trim();
  if (rawText.length < 3) return showBulkItemAddTemplate(phone, session, env);

  const [categories, allItems] = await Promise.all([getCategories(env), getAllMenuItems(env)]);
  const existingNames = allItems.map(i => i.name);
  // UX-14: when a category was chosen up front, pass it so the parser drops
  // the per-line category column.
  const forcedCat = session.adminCtx.bulk.forcedCategoryId
    ? categories.find(c => c.id === session.adminCtx.bulk.forcedCategoryId)
    : null;
  const parsed = parseBulkItemPaste(rawText, categories, existingNames, forcedCat);

  if (parsed.total === 0) return showBulkItemAddTemplate(phone, session, env);

  session.adminCtx.bulk.parsedItems = parsed.valid;
  session.adminCtx.bulk.parseErrors = parsed.errors;
  session.state = 'admin_bulk_items_add_review';
  await saveSession(phone, session, env);

  let previewMsg = `📋 *Bulk Add Preview*\n\nTotal lines: ${parsed.total} | ✅ ${parsed.valid.length} valid | ❌ ${parsed.errors.length} invalid\n\n`;

  if (parsed.valid.length > 0) {
    const preview = parsed.valid.slice(0, 5).map(i => `• *${i.name}* (${i.categoryName}, ${formatPrice(i.price)})`).join('\n');
    previewMsg += `*Items to add:*\n${preview}`;
    if (parsed.valid.length > 5) previewMsg += `\n_…and ${parsed.valid.length - 5} more_`;
  }

  if (parsed.errors.length > 0) {
    const errPreview = parsed.errors.slice(0, 3).map(e => `Line ${e.line}: ${e.reasons[0]}`).join('\n');
    previewMsg += `\n\n*Skipped lines:*\n${errPreview}`;
    if (parsed.errors.length > 3) previewMsg += `\n_…and ${parsed.errors.length - 3} more_`;
  }

  if (previewMsg.length > 900) previewMsg = previewMsg.slice(0, 897) + '…';

  if (parsed.valid.length === 0) {
    return sendButtons(
      phone,
      previewMsg + '\n\n⚠️ No valid items found. Fix errors and re-paste.',
      [
        { id: 'bulk_repaste', title: '🔄 Re-paste' },
        { id: 'admin_bulk_menu', title: '⬅️ Bulk Menu' },
      ],
      env
    );
  }

  return sendButtons(
    phone,
    previewMsg,
    [
      { id: 'bulk_items_add_confirm', title: `✅ Add ${parsed.valid.length} Items` },
      { id: 'bulk_repaste',           title: '🔄 Re-paste'                         },
    ],
    env
  );
}

async function handleBulkItemsAddReview(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  const reviewText = (msg.text || '').trim().toUpperCase();

  // BUG-15: only an explicit re-paste request discards the ready batch — do NOT
  // treat arbitrary text as a re-paste.
  if (msg.id === 'bulk_repaste' || reviewText === 'REPASTE') {
    session.state = 'admin_bulk_items_add_paste';
    await saveSession(phone, session, env);
    return showBulkItemAddTemplate(phone, session, env);
  }

  if (msg.id === 'bulk_items_add_confirm' || reviewText === 'CONFIRM') {
    const items = bulk.parsedItems || [];
    if (!items.length) {
      session.state = 'admin_bulk_items_add_paste';
      await saveSession(phone, session, env);
      return showBulkItemAddTemplate(phone, session, env);
    }

    let successCount = 0;
    let failureCount = 0;
    const failureDetails = [];

    // GAP (N+1): one read of all existing item names instead of a SELECT per
    // item. The dup-check then runs in-memory against this lowercased set.
    const existingRows = await env.DB.prepare('SELECT name FROM MenuItems').all();
    const existingNames = new Set(existingRows.results.map(r => r.name.toLowerCase()));

    for (const item of items) {
      try {
        if (existingNames.has(item.name.toLowerCase())) {
          failureDetails.push({ name: item.name, error: 'duplicate' });
          failureCount++;
        } else {
          await createMenuItem({ categoryId: item.categoryId, name: item.name, description: item.description, price: item.price, imageUrl: item.imageUrl }, env);
          // Guard against duplicates WITHIN the same paste batch too.
          existingNames.add(item.name.toLowerCase());
          successCount++;
        }
      } catch (err) {
        failureCount++;
        failureDetails.push({ name: item.name, error: err.message?.slice(0, 40) });
      }
    }

    if (successCount > 0) await bustMenuCache(env);

    const logId = await logBulkAction({
      adminPhone: phone, actionType: 'bulk_add', targetType: 'menu_items',
      selectedIds: [], successCount, failureCount, skippedCount: 0, failureDetails,
    }, env);

    session.state = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);

    let summary = `✅ *Bulk Add Complete*\n\nAdded: ${successCount}\nFailed: ${failureCount}\nLog ID: ${logId}`;
    if (failureDetails.length) summary += `\n\n*Failures:*\n` + failureDetails.slice(0, 3).map(f => `• ${f.name}: ${f.error}`).join('\n');
    if (summary.length > 900) summary = summary.slice(0, 897) + '…';

    return sendButtons(
      phone, summary,
      [
        { id: 'bulk_items_add', title: '➕ Add More Items' },
        { id: 'admin_bulk_menu', title: '📦 Bulk Actions'  },
      ],
      env
    );
  }

  // BUG-15: re-prompt (keeping the batch) instead of discarding it.
  const n = (bulk.parsedItems || []).length;
  return sendButtons(
    phone,
    `📋 Ready to add *${n}* valid items.\n\nTap *Add* to confirm or *Re-paste* to start over. (Or type CONFIRM / REPASTE.)`,
    [
      { id: 'bulk_items_add_confirm', title: `✅ Add ${n} Items` },
      { id: 'bulk_repaste',           title: '🔄 Re-paste'       },
    ],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// Bulk Items — Remove (paginated selection)
// ─────────────────────────────────────────────────────────────

const BULK_PAGE_SIZE = 7; // 7 items + up to 3 control rows = ≤10 per section

async function showBulkItemsRemoveList(phone, session, env) {
  const { bulk } = session.adminCtx;
  const offset = bulk.page * BULK_PAGE_SIZE;
  const { items, total } = await getMenuItemsPaginated(env, BULK_PAGE_SIZE, offset);

  if (!items.length && bulk.page === 0) {
    session.state = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(phone, '📭 No menu items to remove.', [{ id: 'admin_bulk_menu', title: '📦 Bulk Actions' }], env);
  }

  const rows = items.map(i => ({
    id: `bsr_${i.id}`,
    title: `${bulk.selectedIds.includes(i.id) ? '✅' : '⬜'} ${i.name}`.slice(0, 24),
    description: `${i.is_available ? 'Available' : 'Unavailable'} | ₦${i.price.toFixed(2)}`,
  }));

  if (bulk.page > 0) rows.push({ id: 'bulk_page_prev', title: '⬅️ Prev Page' });
  if (offset + BULK_PAGE_SIZE < total) rows.push({ id: 'bulk_page_next', title: '➡️ Next Page' });
  rows.push({ id: 'bulk_review', title: `✅ Done (${bulk.selectedIds.length} sel.)`, description: 'Proceed to review' });

  const footer = `Page ${bulk.page + 1}/${Math.ceil(total / BULK_PAGE_SIZE)} | ${bulk.selectedIds.length} selected`;
  return sendList(phone, `🗑️ *Remove Items*\nTap to select/deselect.\n${footer}`, 'Select Items', [{ title: 'Menu Items', rows }], env);
}

async function handleBulkItemsRemoveSelect(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id === 'bulk_page_next') { bulk.page++; await saveSession(phone, session, env); return showBulkItemsRemoveList(phone, session, env); }
  if (msg.id === 'bulk_page_prev') { bulk.page = Math.max(0, bulk.page - 1); await saveSession(phone, session, env); return showBulkItemsRemoveList(phone, session, env); }

  if (msg.id?.startsWith('bsr_')) {
    const itemId = parseInt(msg.id.replace('bsr_', ''), 10);
    await toggleSelection(phone, bulk, itemId, env); // GAP: KV read-modify-write, race-safe
    await saveSession(phone, session, env);
    return showBulkItemsRemoveList(phone, session, env);
  }

  if (msg.id === 'bulk_review') {
    if (!bulk.selectedIds.length) return sendText(phone, '⚠️ Select at least one item first.', env);
    const allItems = await getAllMenuItems(env);
    const selectedItems = allItems.filter(i => bulk.selectedIds.includes(i.id));
    const nameList = selectedItems.map(i => `• ${i.name}`).slice(0, 8).join('\n');
    const more = selectedItems.length > 8 ? `\n_…and ${selectedItems.length - 8} more_` : '';
    session.state = 'admin_bulk_items_remove_confirm';
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `🗑️ *Confirm Delete*\n\nDelete ${selectedItems.length} items? *This cannot be undone.*\n\n${nameList}${more}`,
      [
        { id: 'bulk_remove_confirm', title: '🗑️ Delete All' },
        { id: 'bulk_back_select',    title: '⬅️ Back'            },
      ],
      env
    );
  }

  return sendButtons(
    phone,
    `${bulk.selectedIds.length} items selected. Tap items to select, then tap Done.`,
    [
      { id: 'bulk_review', title: `✅ Done (${bulk.selectedIds.length})` },
      { id: 'admin_home',  title: '❌ Cancel'                            },
    ],
    env
  );
}

async function handleBulkItemsRemoveConfirm(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id === 'bulk_back_select') {
    session.state = 'admin_bulk_items_remove_select';
    await saveSession(phone, session, env);
    return showBulkItemsRemoveList(phone, session, env);
  }

  if (msg.id === 'bulk_remove_confirm') {
    await loadSelection(phone, bulk, env); // GAP: re-read authoritative selection before writing
    if (!bulk.selectedIds.length) {
      session.state = 'admin_idle'; session.adminCtx = {};
      await saveSession(phone, session, env);
      return sendText(phone, '⚠️ No items selected.', env);
    }

    const deleted = await bulkDeleteMenuItems(bulk.selectedIds, env);
    if (deleted > 0) await bustMenuCache(env);

    const logId = await logBulkAction({
      adminPhone: phone, actionType: 'bulk_delete', targetType: 'menu_items',
      selectedIds: bulk.selectedIds, successCount: deleted,
      failureCount: bulk.selectedIds.length - deleted, skippedCount: 0, failureDetails: [],
    }, env);

    session.state = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);

    return sendButtons(
      phone,
      `✅ *Bulk Delete Complete*\n\nDeleted: ${deleted}\nSkipped (not found): ${bulk.selectedIds.length - deleted}\nLog ID: ${logId}`,
      [
        { id: 'bulk_items_remove', title: '🗑️ Remove More' },
        { id: 'admin_bulk_menu',   title: '📦 Bulk Actions' },
      ],
      env
    );
  }

  return sendButtons(
    phone,
    `🗑️ Confirm delete of ${bulk.selectedIds.length} items?`,
    [
      { id: 'bulk_remove_confirm', title: '🗑️ Delete All' },
      { id: 'bulk_back_select',    title: '⬅️ Back'            },
    ],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// Bulk Items — Edit (action → value → select → confirm)
// ─────────────────────────────────────────────────────────────

async function showBulkItemsEditActionMenu(phone, env) {
  return sendList(
    phone,
    '✏️ *Bulk Edit Items*\n\nChoose what to change across selected items:',
    'Choose Edit',
    [{
      title: 'Edit Type',
      rows: [
        { id: 'ba_ie_set_avail',   title: 'Mark Available',   description: 'Enable all selected items' },
        { id: 'ba_ie_set_unavail', title: 'Mark Unavailable', description: 'Disable all selected items' },
        { id: 'ba_ie_set_price',   title: 'Set Exact Price',  description: 'Set one price for all' },
        { id: 'ba_ie_adj_price',   title: 'Adjust Price',     description: 'Increase or decrease price' },
        { id: 'ba_ie_move_cat',    title: 'Move to Category', description: 'Reassign to a new category' },
        { id: 'ba_ie_set_desc',    title: 'Set Description',  description: 'Replace description text' },
        { id: 'ba_ie_set_img',     title: 'Set Image URL',    description: 'Apply one URL to all items' },
        { id: 'ba_ie_clear_img',   title: 'Clear Image URLs', description: 'Remove all images' },
      ],
    }],
    env
  );
}

async function handleBulkItemsEditAction(phone, msg, session, env) {
  const { bulk } = session.adminCtx;
  const id = msg.id;

  // Direct-to-select actions (no value needed)
  if (id === 'ba_ie_set_avail' || id === 'ba_ie_set_unavail' || id === 'ba_ie_clear_img') {
    bulk.editAction = id === 'ba_ie_set_avail' ? 'set_avail' : id === 'ba_ie_set_unavail' ? 'set_unavail' : 'clear_img';
    bulk.selectedIds = [];
    bulk.page = 0;
    session.state = 'admin_bulk_items_edit_select';
    await saveSession(phone, session, env);
    return showBulkItemsEditList(phone, session, env);
  }

  // Actions that need a value first
  if (id === 'ba_ie_set_price' || id === 'ba_ie_adj_price' || id === 'ba_ie_move_cat' || id === 'ba_ie_set_desc' || id === 'ba_ie_set_img') {
    bulk.editAction = id.replace('ba_ie_', '');
    session.state = 'admin_bulk_items_edit_value';
    await saveSession(phone, session, env);

    if (id === 'ba_ie_move_cat') {
      const cats = await getCategories(env);
      if (!cats.length) return sendButtons(phone, '⚠️ No categories exist yet.', [{ id: 'admin_add_cat', title: '➕ Create Category' }], env);
      const rows = cats.map(c => ({ id: `biec_${c.id}`, title: c.name }));
      return sendList(phone, '📂 *Move Items*\nChoose the *target category*:', 'Select Category', [{ title: 'Categories', rows }], env);
    }
    if (id === 'ba_ie_adj_price') {
      return sendList(phone, '💰 *Adjust Price*\nChoose adjustment type:',
        'Adj. Type',
        [{ title: 'Type', rows: [
          { id: 'ba_adj_inc_fixed', title: 'Increase by ₦', description: 'Add a fixed amount' },
          { id: 'ba_adj_dec_fixed', title: 'Decrease by ₦', description: 'Subtract a fixed amount' },
          { id: 'ba_adj_inc_pct',   title: 'Increase by %', description: 'Percentage increase' },
          { id: 'ba_adj_dec_pct',   title: 'Decrease by %', description: 'Percentage decrease' },
        ]}],
        env
      );
    }
    if (id === 'ba_ie_set_price') return sendText(phone, '💰 Enter the *new price* (e.g. 1500):\n\nSend *CANCEL* to abort.', env);
    if (id === 'ba_ie_set_desc') return sendText(phone, '📝 Enter the *new description* for all selected items:\n\nSend *CANCEL* to abort.', env);
    if (id === 'ba_ie_set_img') return sendText(phone, '🖼️ Enter the *image URL* (must be https://):\n\nSend *CANCEL* to abort.', env);
  }

  // Invalid input — re-show action menu
  return showBulkItemsEditActionMenu(phone, env);
}

async function handleBulkItemsEditValue(phone, msg, session, env) {
  const { bulk } = session.adminCtx;
  const editAction = bulk.editAction;

  // Category selection
  if (editAction === 'move_cat') {
    if (msg.id?.startsWith('biec_')) {
      const catId = parseInt(msg.id.replace('biec_', ''), 10);
      const cat = await getCategoryById(catId, env);
      if (!cat) return sendText(phone, '⚠️ Category not found. Select from the list.', env);
      bulk.editValue = catId;
      bulk.editValueLabel = cat.name;
      bulk.selectedIds = [];
      bulk.page = 0;
      session.state = 'admin_bulk_items_edit_select';
      await saveSession(phone, session, env);
      return showBulkItemsEditList(phone, session, env);
    }
    // Re-show category list
    const cats = await getCategories(env);
    const rows = cats.map(c => ({ id: `biec_${c.id}`, title: c.name }));
    return sendList(phone, '📂 Choose the *target category*:', 'Select Category', [{ title: 'Categories', rows }], env);
  }

  // Price adjustment type selection
  if (editAction === 'adj_price' && !bulk.editPriceType) {
    const adjTypes = { 'ba_adj_inc_fixed': 'inc_fixed', 'ba_adj_dec_fixed': 'dec_fixed', 'ba_adj_inc_pct': 'inc_pct', 'ba_adj_dec_pct': 'dec_pct' };
    if (adjTypes[msg.id]) {
      bulk.editPriceType = adjTypes[msg.id];
      await saveSession(phone, session, env);
      const isPercent = bulk.editPriceType.includes('pct');
      return sendText(phone, `💰 Enter the *${isPercent ? 'percentage' : 'amount'}* to ${bulk.editPriceType.includes('inc') ? 'increase' : 'decrease'} by:\n\nExample: ${isPercent ? '10' : '200'}\n\nSend *CANCEL* to abort.`, env);
    }
    // Re-show type list
    return sendList(phone, '💰 Choose adjustment type:', 'Adj. Type',
      [{ title: 'Type', rows: [
        { id: 'ba_adj_inc_fixed', title: 'Increase by ₦' },
        { id: 'ba_adj_dec_fixed', title: 'Decrease by ₦' },
        { id: 'ba_adj_inc_pct',   title: 'Increase by %' },
        { id: 'ba_adj_dec_pct',   title: 'Decrease by %' },
      ]}], env
    );
  }

  // Text value input
  if (!msg.text) {
    return sendText(phone, '⚠️ Please send a text value to continue.\n\nSend *CANCEL* to abort.', env);
  }

  if (editAction === 'adj_price' && bulk.editPriceType) {
    const isPercent = bulk.editPriceType.includes('pct');
    const val = parseFloat(msg.text.trim());
    // A percentage can't exceed 100 for a decrease; a fixed amount must be
    // within the price ceiling. parsePrice covers the fixed-amount ceiling.
    if (isNaN(val) || val <= 0) return sendText(phone, '⚠️ Enter a positive number.\n\nSend *CANCEL* to abort.', env);
    if (isPercent && val > 1000) return sendText(phone, '⚠️ Percentage seems too large.\n\nSend *CANCEL* to abort.', env);
    if (!isPercent && parsePrice(msg.text.trim()) === null) return sendText(phone, `⚠️ Amount must be between 1 and ${formatPrice(MAX_PRICE)}.\n\nSend *CANCEL* to abort.`, env);
    bulk.editValue = val;
    bulk.editValueLabel = `${isPercent ? val + '%' : formatPrice(val)} ${bulk.editPriceType.includes('inc') ? 'increase' : 'decrease'}`;
  } else if (editAction === 'set_price') {
    // EDGE-21: validate with parsePrice — rejects non-numeric/zero/over-ceiling.
    const p = parsePrice(msg.text.trim());
    if (p === null) return sendText(phone, `⚠️ Enter a valid price (e.g. 1500). Must be between 1 and ${formatPrice(MAX_PRICE)}.\n\nSend *CANCEL* to abort.`, env);
    bulk.editValue = p;
    bulk.editValueLabel = formatPrice(p);
  } else if (editAction === 'set_desc') {
    bulk.editValue = sanitize(msg.text.trim(), 300);
    bulk.editValueLabel = bulk.editValue.slice(0, 40) + (bulk.editValue.length > 40 ? '…' : '');
  } else if (editAction === 'set_img') {
    const url = msg.text.trim();
    if (!isValidHttpsUrl(url)) return sendText(phone, '⚠️ URL must start with *https://*\n\nSend *CANCEL* to abort.', env);
    bulk.editValue = url;
    bulk.editValueLabel = url.slice(0, 40) + '…';
  } else {
    return sendText(phone, '⚠️ Unexpected input. Send *CANCEL* to abort.', env);
  }

  bulk.selectedIds = [];
  bulk.page = 0;
  session.state = 'admin_bulk_items_edit_select';
  await saveSession(phone, session, env);
  return showBulkItemsEditList(phone, session, env);
}

async function showBulkItemsEditList(phone, session, env) {
  const { bulk } = session.adminCtx;
  const offset = bulk.page * BULK_PAGE_SIZE;
  const { items, total } = await getMenuItemsPaginated(env, BULK_PAGE_SIZE, offset);

  if (!items.length && bulk.page === 0) {
    session.state = 'admin_idle'; session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(phone, '📭 No items in menu yet.', [{ id: 'admin_bulk_menu', title: '📦 Bulk Actions' }], env);
  }

  const actionLabels = { set_avail: 'AVAILABLE', set_unavail: 'UNAVAILABLE', clear_img: 'CLEAR IMAGE', set_price: `price → ${bulk.editValueLabel}`, adj_price: bulk.editValueLabel, move_cat: `→ ${bulk.editValueLabel}`, set_desc: 'SET DESC', set_img: 'SET IMAGE' };
  const actionLabel = actionLabels[bulk.editAction] || bulk.editAction;

  const rows = items.map(i => ({
    id: `bie_${i.id}`,
    title: `${bulk.selectedIds.includes(i.id) ? '✅' : '⬜'} ${i.name}`.slice(0, 24),
    description: `${i.is_available ? 'Avail' : 'Unavail'} | ₦${i.price.toFixed(2)}`,
  }));

  if (bulk.page > 0) rows.push({ id: 'bulk_page_prev', title: '⬅️ Prev Page' });
  if (offset + BULK_PAGE_SIZE < total) rows.push({ id: 'bulk_page_next', title: '➡️ Next Page' });
  rows.push({ id: 'bulk_review', title: `✅ Done (${bulk.selectedIds.length} sel.)`, description: 'Review & confirm' });

  const footer = `Page ${bulk.page + 1}/${Math.ceil(total / BULK_PAGE_SIZE)} | ${bulk.selectedIds.length} selected`;
  return sendList(phone, `✏️ *Edit: ${actionLabel}*\nTap to select items.\n${footer}`, 'Select Items', [{ title: 'Menu Items', rows }], env);
}

async function handleBulkItemsEditSelect(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id === 'bulk_page_next') { bulk.page++; await saveSession(phone, session, env); return showBulkItemsEditList(phone, session, env); }
  if (msg.id === 'bulk_page_prev') { bulk.page = Math.max(0, bulk.page - 1); await saveSession(phone, session, env); return showBulkItemsEditList(phone, session, env); }

  if (msg.id?.startsWith('bie_')) {
    const itemId = parseInt(msg.id.replace('bie_', ''), 10);
    await toggleSelection(phone, bulk, itemId, env); // GAP: KV read-modify-write, race-safe
    await saveSession(phone, session, env);
    return showBulkItemsEditList(phone, session, env);
  }

  if (msg.id === 'bulk_review') {
    if (!bulk.selectedIds.length) return sendText(phone, '⚠️ Select at least one item first.', env);
    session.state = 'admin_bulk_items_edit_confirm';
    await saveSession(phone, session, env);

    const actionLabels = { set_avail: 'Mark AVAILABLE', set_unavail: 'Mark UNAVAILABLE', clear_img: 'Clear image URLs', set_price: `Set price to ${bulk.editValueLabel}`, adj_price: `Adjust price: ${bulk.editValueLabel}`, move_cat: `Move to category: ${bulk.editValueLabel}`, set_desc: `Set description`, set_img: `Set image URL` };
    const actionDesc = actionLabels[bulk.editAction] || bulk.editAction;

    return sendButtons(
      phone,
      `✏️ *Confirm Bulk Edit*\n\nAction: *${actionDesc}*\nItems: ${bulk.selectedIds.length} selected\n\nProceed?`,
      [
        { id: 'bulk_edit_confirm', title: '✅ Apply Changes' },
        { id: 'bulk_back_select',  title: '⬅️ Back'         },
      ],
      env
    );
  }

  return sendButtons(
    phone,
    `${bulk.selectedIds.length} items selected.`,
    [
      { id: 'bulk_review', title: `✅ Done (${bulk.selectedIds.length})` },
      { id: 'admin_home',  title: '❌ Cancel'                            },
    ],
    env
  );
}

async function handleBulkItemsEditConfirm(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id === 'bulk_back_select') {
    session.state = 'admin_bulk_items_edit_select';
    await saveSession(phone, session, env);
    return showBulkItemsEditList(phone, session, env);
  }

  if (msg.id !== 'bulk_edit_confirm') {
    return sendButtons(phone, `Apply edit to ${bulk.selectedIds.length} items?`,
      [{ id: 'bulk_edit_confirm', title: '✅ Apply Changes' }, { id: 'bulk_back_select', title: '⬅️ Back' }], env);
  }

  await loadSelection(phone, bulk, env); // GAP: re-read authoritative selection before writing

  // Build fields object based on action
  let fields = {};
  if (bulk.editAction === 'set_avail')   fields = { is_available: 1 };
  else if (bulk.editAction === 'set_unavail') fields = { is_available: 0 };
  else if (bulk.editAction === 'clear_img')   fields = { image_url: '' };
  else if (bulk.editAction === 'set_price')   fields = { price: bulk.editValue };
  else if (bulk.editAction === 'set_desc')    fields = { description: bulk.editValue };
  else if (bulk.editAction === 'set_img')     fields = { image_url: bulk.editValue };
  else if (bulk.editAction === 'move_cat')    fields = { category_id: bulk.editValue };
  else if (bulk.editAction === 'adj_price') {
    // Must fetch current prices and compute individually
    const allItems = await getAllMenuItems(env);
    const selected = allItems.filter(i => bulk.selectedIds.includes(i.id));
    let successCount = 0;
    const failureDetails = [];
    for (const item of selected) {
      let newPrice;
      const v = bulk.editValue;
      if (bulk.editPriceType === 'inc_fixed')  newPrice = item.price + v;
      else if (bulk.editPriceType === 'dec_fixed') newPrice = item.price - v;
      else if (bulk.editPriceType === 'inc_pct')   newPrice = item.price * (1 + v / 100);
      else if (bulk.editPriceType === 'dec_pct')   newPrice = item.price * (1 - v / 100);
      newPrice = Math.round(newPrice * 100) / 100;
      if (newPrice < 0 || newPrice > MAX_PRICE) {
        failureDetails.push({ id: item.id, name: item.name, error: `result ₦${newPrice.toFixed(2)} out of range` });
        continue;
      }
      try { await updateMenuItem(item.id, { price: newPrice }, env); successCount++; }
      catch (e) { failureDetails.push({ id: item.id, name: item.name, error: e.message?.slice(0, 30) }); }
    }
    if (successCount > 0) await bustMenuCache(env);
    const logId = await logBulkAction({ adminPhone: phone, actionType: 'bulk_adj_price', targetType: 'menu_items', selectedIds: bulk.selectedIds, successCount, failureCount: failureDetails.length, skippedCount: 0, failureDetails }, env);
    session.state = 'admin_idle'; session.adminCtx = {};
    await saveSession(phone, session, env);
    let summary = `✅ *Price Adjust Complete*\n\nUpdated: ${successCount}\nFailed/skipped: ${failureDetails.length}\nLog ID: ${logId}`;
    if (failureDetails.length) summary += '\n\n*Issues:*\n' + failureDetails.slice(0, 3).map(f => `• ${f.name}: ${f.error}`).join('\n');
    if (summary.length > 900) summary = summary.slice(0, 897) + '…';
    return sendButtons(phone, summary, [{ id: 'admin_bulk_menu', title: '📦 Bulk Actions' }, { id: 'admin_home', title: '🔧 Admin Menu' }], env);
  }

  const updatedCount = await bulkEditMenuItems(bulk.selectedIds, fields, env);
  if (updatedCount > 0) await bustMenuCache(env);

  const logId = await logBulkAction({
    adminPhone: phone, actionType: `bulk_edit_${bulk.editAction}`, targetType: 'menu_items',
    targetValue: String(bulk.editValue ?? ''), selectedIds: bulk.selectedIds,
    successCount: updatedCount, failureCount: 0, skippedCount: bulk.selectedIds.length - updatedCount, failureDetails: [],
  }, env);

  session.state = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  return sendButtons(
    phone,
    `✅ *Bulk Edit Complete*\n\nUpdated: ${updatedCount}\nLog ID: ${logId}`,
    [
      { id: 'bulk_items_edit', title: '✏️ Edit More' },
      { id: 'admin_bulk_menu', title: '📦 Bulk Actions'   },
    ],
    env
  );
}

// ─────────────────────────────────────────────────────────────
// Bulk Categories — Add (paste)
// ─────────────────────────────────────────────────────────────

async function showBulkCatAddTemplate(phone, env) {
  return sendText(
    phone,
    '📂 *Bulk Add Categories*\n\n' +
    'Paste category names below, one per line:\n' +
    '*Format:* Name | Sort Order\n\n' +
    '*Examples:*\n' +
    'Burgers | 1\n' +
    'Side Dishes | 2\n' +
    'Drinks\n\n' +
    '*Rules:*\n' +
    '• Name is required (2–50 chars)\n' +
    '• Sort Order optional (number, default 0)\n' +
    '• Name must not already exist\n\n' +
    'Send *CANCEL* to abort.',
    env
  );
}

async function handleBulkCatsAddPaste(phone, msg, session, env) {
  if (!msg.text || msg.type === 'button_reply' || msg.type === 'list_reply') {
    return showBulkCatAddTemplate(phone, env);
  }
  const rawText = msg.text.trim();
  if (rawText.length < 2) return showBulkCatAddTemplate(phone, env);

  const categories = await getCategories(env);
  const parsed = parseBulkCategoryPaste(rawText, categories);

  if (parsed.total === 0) return showBulkCatAddTemplate(phone, env);

  session.adminCtx.bulk.parsedCats = parsed.valid;
  session.adminCtx.bulk.parseErrors = parsed.errors;
  session.state = 'admin_bulk_cats_add_review';
  await saveSession(phone, session, env);

  let previewMsg = `📂 *Bulk Add Categories Preview*\n\nTotal: ${parsed.total} | ✅ ${parsed.valid.length} valid | ❌ ${parsed.errors.length} invalid\n\n`;

  if (parsed.valid.length > 0) {
    const preview = parsed.valid.slice(0, 6).map(c => `• *${c.name}*${c.sortOrder ? ` (sort: ${c.sortOrder})` : ''}`).join('\n');
    previewMsg += `*Categories to add:*\n${preview}`;
    if (parsed.valid.length > 6) previewMsg += `\n_…and ${parsed.valid.length - 6} more_`;
  }

  if (parsed.errors.length > 0) {
    const errPreview = parsed.errors.slice(0, 3).map(e => `Line ${e.line}: ${e.reasons[0]}`).join('\n');
    previewMsg += `\n\n*Skipped lines:*\n${errPreview}`;
    if (parsed.errors.length > 3) previewMsg += `\n_…and ${parsed.errors.length - 3} more_`;
  }

  if (previewMsg.length > 900) previewMsg = previewMsg.slice(0, 897) + '…';

  if (parsed.valid.length === 0) {
    return sendButtons(phone, previewMsg + '\n\n⚠️ No valid categories. Fix errors and re-paste.',
      [{ id: 'bulk_cat_repaste', title: '🔄 Re-paste' }, { id: 'admin_bulk_menu', title: '⬅️ Bulk Menu' }], env);
  }

  return sendButtons(phone, previewMsg,
    [
      { id: 'bulk_cats_add_confirm', title: `✅ Add ${parsed.valid.length} Categories` },
      { id: 'bulk_cat_repaste',      title: '🔄 Re-paste'                              },
    ], env);
}

async function handleBulkCatsAddReview(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id === 'bulk_cat_repaste' || msg.text) {
    session.state = 'admin_bulk_cats_add_paste';
    await saveSession(phone, session, env);
    return showBulkCatAddTemplate(phone, env);
  }

  if (msg.id === 'bulk_cats_add_confirm') {
    const entries = bulk.parsedCats || [];
    if (!entries.length) {
      session.state = 'admin_bulk_cats_add_paste';
      await saveSession(phone, session, env);
      return showBulkCatAddTemplate(phone, env);
    }

    let successCount = 0;
    let failureCount = 0;
    const failureDetails = [];

    for (const entry of entries) {
      try {
        const dup = await env.DB.prepare('SELECT id FROM MenuCategories WHERE LOWER(name) = LOWER(?)').bind(entry.name).first();
        if (dup) {
          failureDetails.push({ name: entry.name, error: 'duplicate' });
          failureCount++;
        } else {
          await env.DB.prepare('INSERT INTO MenuCategories (name, sort_order) VALUES (?, ?)').bind(entry.name, entry.sortOrder || 0).run();
          successCount++;
        }
      } catch (err) {
        failureCount++;
        failureDetails.push({ name: entry.name, error: err.message?.slice(0, 40) });
      }
    }

    if (successCount > 0) {
      await bustMenuCache(env);
      await markFlowStale(env, `${successCount} categories bulk-added`); // GAP: static Add-Item Flow drift
    }

    const logId = await logBulkAction({
      adminPhone: phone, actionType: 'bulk_add', targetType: 'categories',
      selectedIds: [], successCount, failureCount, skippedCount: 0, failureDetails,
    }, env);

    session.state = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);

    let summary = `✅ *Bulk Add Categories Complete*\n\nAdded: ${successCount}\nFailed: ${failureCount}\nLog ID: ${logId}`;
    if (successCount > 0) summary += flowDriftNote(env);
    if (failureDetails.length) summary += '\n\n*Failures:*\n' + failureDetails.slice(0, 3).map(f => `• ${f.name}: ${f.error}`).join('\n');
    if (summary.length > 900) summary = summary.slice(0, 897) + '…';

    return sendButtons(phone, summary,
      [{ id: 'bulk_cats_add', title: '📂 Add More' }, { id: 'admin_bulk_menu', title: '📦 Bulk Actions' }], env);
  }

  const n = (bulk.parsedCats || []).length;
  return sendButtons(phone, `📂 Ready to add *${n}* categories. Confirm or re-paste.`,
    [
      { id: 'bulk_cats_add_confirm', title: `✅ Add ${n} Categories` },
      { id: 'bulk_cat_repaste',      title: '🔄 Re-paste'           },
    ], env);
}

// ─────────────────────────────────────────────────────────────
// Bulk Categories — Rename (single-at-a-time with list)
// ─────────────────────────────────────────────────────────────

async function showBulkCatsRenameList(phone, env) {
  const cats = await getCategories(env);
  if (!cats.length) {
    return sendButtons(phone, '📭 No categories to rename.',
      [{ id: 'admin_bulk_menu', title: '📦 Bulk Actions' }], env);
  }
  const rows = cats.map(c => ({ id: `bcrn_${c.id}`, title: c.name, description: `Sort: ${c.sort_order}` }));
  return sendList(phone, '✏️ *Rename Category*\nSelect a category to rename:', 'Select', [{ title: 'Categories', rows }], env);
}

async function handleBulkCatsRenameSelect(phone, msg, session, env) {
  if (!msg.id?.startsWith('bcrn_')) return showBulkCatsRenameList(phone, env);

  const catId = parseInt(msg.id.replace('bcrn_', ''), 10);
  const cat = await getCategoryById(catId, env);
  if (!cat) return sendAdminError(phone, '⚠️ Category not found.', env);

  session.adminCtx.bulk.renameCatId = catId;
  session.adminCtx.bulk.renameCatOldName = cat.name;
  session.state = 'admin_bulk_cats_rename_value';
  await saveSession(phone, session, env);

  return sendText(phone, `✏️ Renaming *${cat.name}*\n\nEnter the *new name*:\n\nSend *CANCEL* to abort.`, env);
}

async function handleBulkCatsRenameValue(phone, msg, session, env) {
  const { bulk } = session.adminCtx;
  if (!bulk.renameCatId) {
    session.state = 'admin_idle'; session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendAdminError(phone, '⚠️ Session lost. Please start over.', env);
  }

  if (!msg.text || msg.type !== 'text') {
    return sendText(phone, `✏️ Enter the *new name* for "${bulk.renameCatOldName}":\n\nSend *CANCEL* to abort.`, env);
  }

  const newName = sanitize(msg.text.trim(), 50);
  if (newName.length < 2) return sendText(phone, '⚠️ Name must be at least 2 characters.\n\nSend *CANCEL* to abort.', env);

  try {
    const dup = await env.DB.prepare('SELECT id FROM MenuCategories WHERE LOWER(name) = LOWER(?) AND id != ?').bind(newName, bulk.renameCatId).first();
    if (dup) return sendText(phone, `⚠️ Category "${newName}" already exists. Choose a different name.`, env);

    await updateCategory(bulk.renameCatId, { name: newName }, env);
    await bustMenuCache(env);
    await markFlowStale(env, `category renamed: ${bulk.renameCatOldName} → ${newName}`); // GAP: static Add-Item Flow drift

    const logId = await logBulkAction({
      adminPhone: phone, actionType: 'rename', targetType: 'categories',
      targetValue: newName, selectedIds: [bulk.renameCatId], successCount: 1, failureCount: 0, skippedCount: 0, failureDetails: [],
    }, env);

    session.state = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);

    return sendButtons(phone,
      `✅ Category renamed: *${bulk.renameCatOldName}* → *${newName}*\nLog ID: ${logId}${flowDriftNote(env)}`,
      [
        { id: 'bulk_cats_rename', title: '✏️ Rename Again' },
        { id: 'admin_bulk_menu',  title: '📦 Bulk Actions'   },
      ], env);
  } catch (err) {
    console.error('[Admin] Category rename failed:', err);
    return sendAdminError(phone, '⚠️ Failed to rename category. Please try again.', env);
  }
}

// ─────────────────────────────────────────────────────────────
// Bulk Categories — Delete (select → mode → [target] → confirm)
// ─────────────────────────────────────────────────────────────

async function showBulkCatsDeleteList(phone, session, env) {
  const cats = await getCategories(env);
  if (!cats.length) {
    session.state = 'admin_idle'; session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(phone, '📭 No categories to delete.', [{ id: 'admin_bulk_menu', title: '📦 Bulk Actions' }], env);
  }
  const itemCounts = await getItemCountsByCategory(env);
  const { bulk } = session.adminCtx;
  // Cap at 9 to leave room for the Done row (max 10 rows per section)
  const pageCats = cats.slice(0, 9);
  const rows = pageCats.map(c => ({
    id: `bcd_${c.id}`,
    title: `${bulk.selectedIds.includes(c.id) ? '✅' : '⬜'} ${c.name}`.slice(0, 24),
    description: `${itemCounts[c.id] || 0} items`,
  }));
  rows.push({ id: 'bulk_review', title: `✅ Done (${bulk.selectedIds.length} sel.)`, description: 'Choose how to handle items' });
  const truncNote = cats.length > 9 ? `\n_Showing 9 of ${cats.length} categories_` : '';
  return sendList(phone, `🗑️ *Delete Categories*\nTap to select. ${bulk.selectedIds.length} selected.${truncNote}`, 'Select', [{ title: 'Categories', rows }], env);
}

async function handleBulkCatsDeleteSelect(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id?.startsWith('bcd_')) {
    const catId = parseInt(msg.id.replace('bcd_', ''), 10);
    await toggleSelection(phone, bulk, catId, env); // GAP: KV read-modify-write, race-safe
    await saveSession(phone, session, env);
    return showBulkCatsDeleteList(phone, session, env);
  }

  if (msg.id === 'bulk_review') {
    await loadSelection(phone, bulk, env); // GAP: re-read authoritative selection at commit
    if (!bulk.selectedIds.length) return sendText(phone, '⚠️ Select at least one category first.', env);

    const itemCounts = await getItemCountsByCategory(env);
    const totalItems = bulk.selectedIds.reduce((sum, id) => sum + (itemCounts[id] || 0), 0);
    const cats = await getCategories(env);
    const selectedCats = cats.filter(c => bulk.selectedIds.includes(c.id));
    const catNames = selectedCats.map(c => `• ${c.name} (${itemCounts[c.id] || 0} items)`).join('\n');

    session.state = 'admin_bulk_cats_delete_mode';
    await saveSession(phone, session, env);

    return sendButtons(
      phone,
      `🗑️ *Delete ${selectedCats.length} Categories*\n\n${catNames}\n\nTotal items affected: *${totalItems}*\n\n*How should items be handled?*`,
      [
        { id: 'bcd_mode_cascade', title: '🗑️ Delete Items' },
        { id: 'bcd_mode_move',    title: '🔀 Move Items' },
      ],
      env
    );
  }

  return sendButtons(phone, `${bulk.selectedIds.length} categories selected.`,
    [{ id: 'bulk_review', title: `✅ Done (${bulk.selectedIds.length})` }, { id: 'admin_home', title: '❌ Cancel' }], env);
}

async function handleBulkCatsDeleteMode(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id === 'bcd_mode_cascade') {
    bulk.deleteMode = 'cascade';
    session.state = 'admin_bulk_cats_delete_confirm';
    await saveSession(phone, session, env);
    const itemCounts = await getItemCountsByCategory(env);
    const totalItems = bulk.selectedIds.reduce((sum, id) => sum + (itemCounts[id] || 0), 0);
    return sendButtons(
      phone,
      `⚠️ *Final Confirm*\n\nDelete ${bulk.selectedIds.length} categories AND all *${totalItems} items* in them?\n\n*This cannot be undone.*`,
      [
        { id: 'bcd_confirm_yes', title: '⚠️ Yes, Delete' },
        { id: 'bcd_back',        title: '⬅️ Back'            },
      ],
      env
    );
  }

  if (msg.id === 'bcd_mode_move') {
    bulk.deleteMode = 'move';
    session.state = 'admin_bulk_cats_delete_target';
    await saveSession(phone, session, env);

    const allCats = await getCategories(env);
    const eligible = allCats.filter(c => !bulk.selectedIds.includes(c.id));
    if (!eligible.length) {
      return sendButtons(phone, '⚠️ No other categories to move items into. Delete items first or create a new category.',
        [{ id: 'admin_add_cat', title: '➕ New Category' }, { id: 'admin_bulk_menu', title: '⬅️ Back' }], env);
    }
    const rows = eligible.map(c => ({ id: `bcdt_${c.id}`, title: c.name }));
    return sendList(phone, '🔀 *Move Items To*\nSelect the target category for all items:', 'Select', [{ title: 'Categories', rows }], env);
  }

  return sendButtons(phone, '⚠️ Choose how to handle items in deleted categories:',
    [{ id: 'bcd_mode_cascade', title: '🗑️ Delete Items' }, { id: 'bcd_mode_move', title: '🔀 Move Items First' }], env);
}

async function handleBulkCatsDeleteTarget(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (!msg.id?.startsWith('bcdt_')) {
    const cats = await getCategories(env);
    const eligible = cats.filter(c => !bulk.selectedIds.includes(c.id));
    const rows = eligible.map(c => ({ id: `bcdt_${c.id}`, title: c.name }));
    return sendList(phone, '🔀 Choose target category for items:', 'Select', [{ title: 'Categories', rows }], env);
  }

  const targetCatId = parseInt(msg.id.replace('bcdt_', ''), 10);
  const target = await getCategoryById(targetCatId, env);
  if (!target) return sendAdminError(phone, '⚠️ Category not found.', env);

  bulk.deleteTargetCatId = targetCatId;
  bulk.deleteTargetCatName = target.name;
  session.state = 'admin_bulk_cats_delete_confirm';
  await saveSession(phone, session, env);

  const itemCounts = await getItemCountsByCategory(env);
  const totalItems = bulk.selectedIds.reduce((sum, id) => sum + (itemCounts[id] || 0), 0);

  return sendButtons(
    phone,
    `⚠️ *Final Confirm*\n\nMove *${totalItems} items* to *${target.name}*, then delete ${bulk.selectedIds.length} categories?\n\n*This cannot be undone.*`,
    [
      { id: 'bcd_confirm_yes', title: '✅ Yes, Proceed' },
      { id: 'bcd_back',        title: '⬅️ Back'         },
    ],
    env
  );
}

async function handleBulkCatsDeleteConfirm(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id === 'bcd_back') {
    session.state = 'admin_bulk_cats_delete_select';
    await saveSession(phone, session, env);
    return showBulkCatsDeleteList(phone, session, env);
  }

  if (msg.id !== 'bcd_confirm_yes') {
    return sendButtons(phone, '⚠️ Confirm deletion?',
      [{ id: 'bcd_confirm_yes', title: '✅ Yes, Proceed' }, { id: 'bcd_back', title: '⬅️ Back' }], env);
  }

  await loadSelection(phone, bulk, env); // GAP: re-read authoritative selection before writing

  let deletedCats = 0;
  let movedItems = 0;

  // BUG-16: wrap the cascade/move delete so an FK failure shows a clear message
  // and an admin_home button instead of stranding the admin in a dead state.
  try {
    if (bulk.deleteMode === 'move' && bulk.deleteTargetCatId) {
      for (const catId of bulk.selectedIds) {
        await moveAllItemsFromCategory(catId, bulk.deleteTargetCatId, env);
        movedItems++;
      }
    }
    deletedCats = await bulkDeleteCategoriesWithItems(bulk.selectedIds, env);
    await bustMenuCache(env);
  } catch (err) {
    console.error('[Admin] Bulk category delete failed:', err);
    session.state    = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);
    return sendButtons(
      phone,
      `⚠️ Could not delete those categories.\n\n` +
      `Some items may still reference them. ${err.message?.slice(0, 60) || ''}`,
      [
        { id: 'admin_bulk_menu', title: '📦 Bulk Actions' },
        { id: 'admin_home',      title: '🔧 Admin Menu'   },
      ],
      env
    );
  }

  const logId = await logBulkAction({
    adminPhone: phone, actionType: bulk.deleteMode === 'move' ? 'bulk_delete_move' : 'bulk_delete_cascade',
    targetType: 'categories', targetValue: bulk.deleteTargetCatName || '',
    selectedIds: bulk.selectedIds, successCount: deletedCats, failureCount: 0, skippedCount: 0, failureDetails: [],
  }, env);

  session.state = 'admin_idle';
  session.adminCtx = {};
  await saveSession(phone, session, env);

  const modeNote = bulk.deleteMode === 'move' ? `Items moved to "${bulk.deleteTargetCatName}".` : 'Items deleted with categories.';
  return sendButtons(phone,
    `✅ *Bulk Delete Complete*\n\nCategories deleted: ${deletedCats}\n${modeNote}\nLog ID: ${logId}`,
    [{ id: 'admin_bulk_menu', title: '📦 Bulk Actions' }, { id: 'admin_home', title: '🔧 Admin Menu' }], env);
}

// ─────────────────────────────────────────────────────────────
// Bulk Categories — Move Items (source → items → target → confirm)
// ─────────────────────────────────────────────────────────────

async function showBulkCatsMoveSourceList(phone, env) {
  const cats = await getCategories(env);
  if (!cats.length) {
    return sendButtons(phone, '📭 No categories yet.', [{ id: 'admin_bulk_menu', title: '📦 Bulk Actions' }], env);
  }
  const itemCounts = await getItemCountsByCategory(env);
  const rows = cats.filter(c => (itemCounts[c.id] || 0) > 0).map(c => ({
    id: `bcms_${c.id}`,
    title: c.name,
    description: `${itemCounts[c.id]} items`,
  }));
  if (!rows.length) {
    return sendButtons(phone, '📭 No categories have items to move.', [{ id: 'admin_bulk_menu', title: '📦 Bulk Actions' }], env);
  }
  return sendList(phone, '🔀 *Move Items*\nSelect the *source category* to move items from:', 'Select Source', [{ title: 'Categories', rows }], env);
}

async function handleBulkCatsMoveSource(phone, msg, session, env) {
  if (!msg.id?.startsWith('bcms_')) return showBulkCatsMoveSourceList(phone, env);

  const srcId = parseInt(msg.id.replace('bcms_', ''), 10);
  const src = await getCategoryById(srcId, env);
  if (!src) return sendAdminError(phone, '⚠️ Category not found.', env);

  session.adminCtx.bulk.moveSourceId = srcId;
  session.adminCtx.bulk.moveSourceName = src.name;
  session.state = 'admin_bulk_cats_move_target';
  await saveSession(phone, session, env);

  const allCats = await getCategories(env);
  const eligible = allCats.filter(c => c.id !== srcId);
  if (!eligible.length) {
    return sendButtons(phone, '⚠️ No other categories to move items into.',
      [{ id: 'admin_add_cat', title: '➕ New Category' }, { id: 'admin_bulk_menu', title: '⬅️ Back' }], env);
  }
  const rows = eligible.map(c => ({ id: `bcmt_${c.id}`, title: c.name }));
  return sendList(phone, `🔀 Moving from *${src.name}*\n\nChoose the *target category*:`, 'Select Target', [{ title: 'Categories', rows }], env);
}

async function handleBulkCatsMoveTarget(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (!msg.id?.startsWith('bcmt_')) {
    const allCats = await getCategories(env);
    const eligible = allCats.filter(c => c.id !== bulk.moveSourceId);
    const rows = eligible.map(c => ({ id: `bcmt_${c.id}`, title: c.name }));
    return sendList(phone, `🔀 Choose the *target category*:`, 'Select Target', [{ title: 'Categories', rows }], env);
  }

  const targetId = parseInt(msg.id.replace('bcmt_', ''), 10);
  const target = await getCategoryById(targetId, env);
  if (!target) return sendAdminError(phone, '⚠️ Category not found.', env);

  bulk.moveTargetId = targetId;
  bulk.moveTargetName = target.name;
  session.state = 'admin_bulk_cats_move_confirm';
  await saveSession(phone, session, env);

  const itemCounts = await getItemCountsByCategory(env);
  const count = itemCounts[bulk.moveSourceId] || 0;

  return sendButtons(
    phone,
    `🔀 *Confirm Move*\n\nMove *${count} items* from *${bulk.moveSourceName}* → *${target.name}*?`,
    [
      { id: 'bcm_confirm', title: '✅ Yes, Move All' },
      { id: 'bcm_back',    title: '⬅️ Back'          },
    ],
    env
  );
}

async function handleBulkCatsMoveConfirm(phone, msg, session, env) {
  const { bulk } = session.adminCtx;

  if (msg.id === 'bcm_back') {
    session.state = 'admin_bulk_cats_move_source';
    await saveSession(phone, session, env);
    return showBulkCatsMoveSourceList(phone, env);
  }

  if (msg.id !== 'bcm_confirm') {
    return sendButtons(phone, `🔀 Move items from *${bulk.moveSourceName}* → *${bulk.moveTargetName}*?`,
      [{ id: 'bcm_confirm', title: '✅ Yes, Move All' }, { id: 'bcm_back', title: '⬅️ Back' }], env);
  }

  try {
    await moveAllItemsFromCategory(bulk.moveSourceId, bulk.moveTargetId, env);
    await bustMenuCache(env);

    const itemCounts = await getItemCountsByCategory(env);
    const movedCount = itemCounts[bulk.moveTargetId] || 0;

    const logId = await logBulkAction({
      adminPhone: phone, actionType: 'bulk_move_items', targetType: 'categories',
      targetValue: String(bulk.moveTargetId), selectedIds: [bulk.moveSourceId],
      successCount: 1, failureCount: 0, skippedCount: 0, failureDetails: [],
    }, env);

    session.state = 'admin_idle';
    session.adminCtx = {};
    await saveSession(phone, session, env);

    return sendButtons(phone,
      `✅ *Move Complete*\n\nAll items moved from *${bulk.moveSourceName}* → *${bulk.moveTargetName}*\nLog ID: ${logId}`,
      [{ id: 'bulk_cats_move', title: '🔀 Move More' }, { id: 'admin_bulk_menu', title: '📦 Bulk Actions' }], env);
  } catch (err) {
    console.error('[Admin] Move items failed:', err);
    return sendAdminError(phone, `⚠️ Failed to move items: ${err.message?.slice(0, 60)}`, env);
  }
}
