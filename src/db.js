/**
 * src/db.js — D1 Database Access Layer
 *
 * All SQL lives here. Workers D1 uses a prepared-statement API
 * that mirrors better-sqlite3 but is async.
 */

// ─────────────────────────────────────────────────────────────
// Menu
// ─────────────────────────────────────────────────────────────

/** Returns full menu: { categories: [...], itemsByCategory: { id: [...] } } */
export async function getFullMenu(env) {
  const categories = await env.DB.prepare(
    'SELECT id, name FROM MenuCategories ORDER BY sort_order, name'
  ).all();

  const items = await env.DB.prepare(
    `SELECT id, category_id, name, description, price, image_url
     FROM MenuItems
     WHERE is_available = 1
     ORDER BY category_id, name`
  ).all();

  const itemsByCategory = {};
  for (const item of items.results) {
    if (!itemsByCategory[item.category_id]) {
      itemsByCategory[item.category_id] = [];
    }
    itemsByCategory[item.category_id].push(item);
  }

  return { categories: categories.results, itemsByCategory };
}

export async function getMenuItem(id, env) {
  return env.DB.prepare(
    'SELECT * FROM MenuItems WHERE id = ?'
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

// Columns that are permitted to be updated via updateMenuItem
const ALLOWED_ITEM_COLUMNS = new Set([
  'name', 'description', 'price', 'image_url', 'is_available', 'category_id',
]);

export async function updateMenuItem(id, fields, env) {
  const setClauses = [];
  const values = [];

  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_ITEM_COLUMNS.has(k)) {
      throw new Error(`updateMenuItem: column "${k}" is not allowed`);
    }
    setClauses.push(`${k} = ?`);
    values.push(v);
  }

  if (!setClauses.length) throw new Error('updateMenuItem: no fields to update');

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
    'SELECT id, name FROM MenuCategories ORDER BY sort_order, name'
  ).all();
  return result.results;
}

// ─────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────

export async function createOrder(order, env) {
  const { userPhone, totalPrice, address, notes } = order;

  // D1 batch executes as a single transaction — if any statement fails,
  // the entire batch is rolled back. We use a two-phase batch:
  // 1. INSERT the order, 2. INSERT all items.
  // Because we need the auto-generated order ID for the items, we can't
  // batch the parent INSERT with the children directly. Instead we rely on
  // the fact that D1 batch() is atomic: if the items batch fails we catch
  // the error and manually delete the orphaned order.

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
  } catch (err) {
    // Rollback: delete the orphaned order so we don't leave zombie records
    await env.DB.prepare('DELETE FROM Orders WHERE id = ?').bind(orderId).run().catch(() => {});
    throw err;  // Re-throw so the caller sees the failure
  }

  return orderId;
}

export async function getOrder(id, env) {
  const order = await env.DB.prepare(
    'SELECT * FROM Orders WHERE id = ?'
  ).bind(id).first();

  if (!order) return null;

  const items = await env.DB.prepare(
    'SELECT * FROM OrderItems WHERE order_id = ?'
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
