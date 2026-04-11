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

export async function updateMenuItem(id, fields, env) {
  const setClauses = [];
  const values = [];
  for (const [k, v] of Object.entries(fields)) {
    setClauses.push(`${k} = ?`);
    values.push(v);
  }
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

  const orderResult = await env.DB.prepare(
    `INSERT INTO Orders (user_phone, total_price, address, notes)
     VALUES (?, ?, ?, ?)`
  ).bind(userPhone, totalPrice, address || '', notes || '').run();

  const orderId = orderResult.meta.last_row_id;

  // Insert all order items in a batch
  const stmts = order.items.map(item =>
    env.DB.prepare(
      `INSERT INTO OrderItems (order_id, menu_item_id, name, quantity, unit_price, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(orderId, item.itemId, item.name, item.qty, item.unitPrice, item.notes || '')
  );

  await env.DB.batch(stmts);

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
