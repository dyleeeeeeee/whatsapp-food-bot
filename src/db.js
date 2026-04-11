/**
 * src/db.js — D1 Database Access Layer
 *
 * BUG-11: createOrder cleanup failure now logs a CRITICAL error instead of
 *         silently swallowing it.
 * BUG-13: getFullMenu fetches categories and items in parallel (Promise.all).
 * BUG-14: All queries use explicit column lists — no SELECT *.
 */

// ─────────────────────────────────────────────────────────────
// Menu
// ─────────────────────────────────────────────────────────────

/**
 * Fetch the full menu from D1.
 * Returns { categories: [...], itemsByCategory: { catId: [...] } }
 *
 * BUG-13 FIX: Categories and items are fetched in parallel, cutting
 * menu load latency roughly in half on a cache miss.
 */
export async function getFullMenu(env) {
  const [catResult, itemResult] = await Promise.all([
    env.DB.prepare(
      'SELECT id, name, sort_order FROM MenuCategories ORDER BY sort_order, name'
    ).all(),
    env.DB.prepare(
      `SELECT id, category_id, name, description, price, image_url, is_available
       FROM MenuItems
       WHERE is_available = 1
       ORDER BY category_id, name`
    ).all(),
  ]);

  const itemsByCategory = {};
  for (const item of itemResult.results) {
    if (!itemsByCategory[item.category_id]) {
      itemsByCategory[item.category_id] = [];
    }
    itemsByCategory[item.category_id].push(item);
  }

  return { categories: catResult.results, itemsByCategory };
}

/**
 * Fetch ALL menu items regardless of availability.
 * Used by admin flows so unavailable items remain editable/deletable.
 *
 * BUG-04 FIX (support): admin edit/delete/toggle need to see ALL items,
 * not just available ones. This function provides that.
 */
export async function getAllMenuItems(env) {
  const result = await env.DB.prepare(
    `SELECT id, category_id, name, description, price, image_url, is_available
     FROM MenuItems
     ORDER BY name`
  ).all();
  return result.results;
}

/**
 * Fetch a single menu item by ID.
 * BUG-14 FIX: Explicit columns instead of SELECT *.
 */
export async function getMenuItem(id, env) {
  return env.DB.prepare(
    `SELECT id, category_id, name, description, price, image_url, is_available
     FROM MenuItems WHERE id = ?`
  ).bind(id).first();
}

export async function createMenuItem(item, env) {
  const { categoryId, name, description, price, imageUrl } = item;
  const result = await env.DB.prepare(
    `INSERT INTO MenuItems (category_id, name, description, price, image_url)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(categoryId, name, description || '', price, imageUrl || '').run();
  return result.meta.last_row_id;
}

// Columns permitted to be updated via updateMenuItem
const ALLOWED_ITEM_COLUMNS = new Set([
  'name', 'description', 'price', 'image_url', 'is_available', 'category_id',
]);

export async function updateMenuItem(id, fields, env) {
  const setClauses = [];
  const values = [];

  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_ITEM_COLUMNS.has(k)) {
      throw new Error(`updateMenuItem: column "${k}" is not in the allowed list`);
    }
    setClauses.push(`${k} = ?`);
    values.push(v);
  }

  if (!setClauses.length) throw new Error('updateMenuItem: no fields provided');

  values.push(id);
  await env.DB.prepare(
    `UPDATE MenuItems SET ${setClauses.join(', ')} WHERE id = ?`
  ).bind(...values).run();
}

export async function deleteMenuItem(id, env) {
  await env.DB.prepare('DELETE FROM MenuItems WHERE id = ?').bind(id).run();
}

export async function getCategories(env) {
  const result = await env.DB.prepare(
    'SELECT id, name, sort_order FROM MenuCategories ORDER BY sort_order, name'
  ).all();
  return result.results;
}

// ─────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────

/**
 * Create an order and its items.
 *
 * BUG-11 FIX: Cleanup failure on zombie order now logs a CRITICAL error
 * with the orphaned order ID so it can be manually resolved, instead of
 * silently discarding the failure with `.catch(() => {})`.
 */
export async function createOrder(order, env) {
  const { userPhone, totalPrice, address, notes } = order;

  const orderResult = await env.DB.prepare(
    `INSERT INTO Orders (user_phone, total_price, address, notes)
     VALUES (?, ?, ?, ?)`
  ).bind(userPhone, totalPrice, address || '', notes || '').run();

  const orderId = orderResult.meta.last_row_id;

  try {
    const stmts = order.items.map(item =>
      env.DB.prepare(
        `INSERT INTO OrderItems (order_id, menu_item_id, name, quantity, unit_price, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(orderId, item.itemId, item.name, item.qty, item.unitPrice, item.notes || '')
    );
    await env.DB.batch(stmts);
  } catch (batchErr) {
    // BUG-11 FIX: attempt to delete the orphaned parent order
    await env.DB.prepare('DELETE FROM Orders WHERE id = ?')
      .bind(orderId)
      .run()
      .catch(cleanupErr => {
        // Log at CRITICAL level — this orphan needs manual cleanup
        console.error(
          `[DB] CRITICAL: Failed to cleanup zombie order #${orderId}. ` +
          `Manual DELETE required. Cleanup error:`, cleanupErr
        );
      });
    throw batchErr; // surface original error to caller
  }

  return orderId;
}

/**
 * BUG-14 FIX: Explicit column lists, no SELECT *.
 */
export async function getOrder(id, env) {
  const order = await env.DB.prepare(
    `SELECT id, user_phone, total_price, status, address, notes, created_at, updated_at
     FROM Orders WHERE id = ?`
  ).bind(id).first();

  if (!order) return null;

  const items = await env.DB.prepare(
    `SELECT id, order_id, menu_item_id, name, quantity, unit_price, notes
     FROM OrderItems WHERE order_id = ?`
  ).bind(id).all();

  return { ...order, items: items.results };
}

export async function getUserOrders(phone, env, limit = 5) {
  const result = await env.DB.prepare(
    `SELECT id, total_price, status, created_at
     FROM Orders WHERE user_phone = ?
     ORDER BY created_at DESC LIMIT ?`
  ).bind(phone, limit).all();
  return result.results;
}

export async function getPendingOrders(env, limit = 20) {
  const result = await env.DB.prepare(
    `SELECT id, user_phone, total_price, status, address, created_at
     FROM Orders
     WHERE status IN ('pending','confirmed','preparing')
     ORDER BY created_at ASC LIMIT ?`
  ).bind(limit).all();
  return result.results;
}

export async function updateOrderStatus(orderId, status, env) {
  await env.DB.prepare(
    `UPDATE Orders SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(status, orderId).run();
}

// ─────────────────────────────────────────────────────────────
// Admin Users
// ─────────────────────────────────────────────────────────────

export async function addAdmin(phone, name, env) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO AdminUsers (phone_number, name) VALUES (?, ?)'
  ).bind(phone, name || 'Admin').run();
}
