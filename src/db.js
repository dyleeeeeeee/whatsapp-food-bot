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



/**

 * Fetch a single menu item by ID, only if currently available.

 * Used in the add-to-cart flow so unavailable items cannot be added.

 */

export async function getAvailableMenuItem(id, env) {

  return env.DB.prepare(

    `SELECT id, category_id, name, description, price, image_url, is_available

     FROM MenuItems WHERE id = ? AND is_available = 1`

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

 *

 * CRITICAL FIX: totalPrice is calculated server-side from items to prevent

 * price tampering. The client-provided total is ignored.

 */

export async function createOrder(order, env) {

  const { userPhone, address, orderNotes } = order;



  // CRITICAL: Calculate total server-side in integer cents to avoid float errors

  const totalCents = order.items.reduce(

    (sum, i) => sum + Math.round(i.unitPrice * 100) * i.qty,

    0

  );

  const totalPrice = Math.round(totalCents) / 100;



  const orderResult = await env.DB.prepare(

    `INSERT INTO Orders (user_phone, total_price, address, notes, payment_status, payment_reference, payment_url, payment_access_code)

     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

  ).bind(

    userPhone,

    totalPrice,

    address || '',

    orderNotes || '',

    order.paymentStatus || 'unpaid',

    order.paymentReference || null,

    order.paymentUrl || null,

    order.paymentAccessCode || null

  ).run();



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

    `SELECT id, user_phone, total_price, status, address, notes,

            payment_status, payment_reference, payment_url, payment_access_code, paid_at,

            created_at, updated_at

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
    `SELECT id, total_price, status, payment_status, created_at
     FROM Orders WHERE user_phone = ?
     ORDER BY created_at DESC LIMIT ?`
  ).bind(phone, limit).all();
  return result.results;
}

export async function getPendingOrders(env, limit = 20) {
  const result = await env.DB.prepare(
    `SELECT id, user_phone, total_price, status, payment_status, address, created_at
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

export async function updateOrderPayment(orderId, fields, env) {
  const allowed = ['payment_status', 'payment_reference', 'payment_url', 'payment_access_code', 'paid_at'];
  const setClauses = [];
  const values = [];

  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      setClauses.push(`${k} = ?`);
      values.push(v);
    }
  }

  if (!setClauses.length) return;

  setClauses.push("updated_at = datetime('now')");
  values.push(orderId);

  await env.DB.prepare(
    `UPDATE Orders SET ${setClauses.join(', ')} WHERE id = ?`
  ).bind(...values).run();
}

export async function getOrderByReference(reference, env) {
  return env.DB.prepare(
    `SELECT * FROM Orders WHERE payment_reference = ?`
  ).bind(reference).first();
}

// ─────────────────────────────────────────────────────────────
// Bulk Actions
// ─────────────────────────────────────────────────────────────

export async function logBulkAction(data, env) {
  const {
    adminPhone, actionType, targetType, targetValue, selectedIds,
    successCount, failureCount, skippedCount, failureDetails,
    notifyCustomers, cancellationReason
  } = data;

  const result = await env.DB.prepare(
    `INSERT INTO BulkActionLogs (
      admin_phone, action_type, target_type, target_value, selected_ids_json,
      success_count, failure_count, skipped_count, failure_details_json,
      notify_customers, cancellation_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    adminPhone,
    actionType,
    targetType,
    targetValue || '',
    JSON.stringify(selectedIds || []),
    successCount || 0,
    failureCount || 0,
    skippedCount || 0,
    JSON.stringify(failureDetails || []),
    notifyCustomers ? 1 : 0,
    cancellationReason || ''
  ).run();

  return result.meta.last_row_id;
}

export async function bulkUpdateOrderStatus(orderIds, status, env) {
  const stmts = orderIds.map(id => 
    env.DB.prepare(`UPDATE Orders SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(status, id)
  );
  return env.DB.batch(stmts);
}

export async function bulkUpdateMenuAvailability(itemIds, isAvailable, env) {
  const stmts = itemIds.map(id =>
    env.DB.prepare(`UPDATE MenuItems SET is_available = ? WHERE id = ?`)
      .bind(isAvailable ? 1 : 0, id)
  );
  return env.DB.batch(stmts);
}

export async function bulkDeleteMenuItems(itemIds, env) {
  if (!itemIds.length) return 0;
  const stmts = itemIds.map(id => env.DB.prepare('DELETE FROM MenuItems WHERE id = ?').bind(id));
  const results = await env.DB.batch(stmts);
  return results.filter(r => r.meta.changes > 0).length;
}

export async function bulkCreateMenuItems(items, env) {
  if (!items.length) return [];
  const stmts = items.map(item =>
    env.DB.prepare(
      'INSERT INTO MenuItems (category_id, name, description, price, image_url, is_available) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(item.categoryId, item.name, item.description || '', item.price, item.imageUrl || '', item.isAvailable !== false ? 1 : 0)
  );
  const results = await env.DB.batch(stmts);
  return results.map(r => r.meta.last_row_id);
}

export async function bulkEditMenuItems(itemIds, fields, env) {
  if (!itemIds.length) return 0;
  const ALLOWED = new Set(['name', 'description', 'price', 'image_url', 'is_available', 'category_id']);
  const setClauses = [];
  const baseValues = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.has(k)) continue;
    setClauses.push(`${k} = ?`);
    baseValues.push(v);
  }
  if (!setClauses.length) return 0;
  const stmts = itemIds.map(id =>
    env.DB.prepare(`UPDATE MenuItems SET ${setClauses.join(', ')} WHERE id = ?`).bind(...baseValues, id)
  );
  const results = await env.DB.batch(stmts);
  return results.filter(r => r.meta.changes > 0).length;
}

export async function getCategoryById(id, env) {
  return env.DB.prepare('SELECT id, name, sort_order FROM MenuCategories WHERE id = ?').bind(id).first();
}

export async function updateCategory(id, fields, env) {
  const ALLOWED = new Set(['name', 'sort_order']);
  const setClauses = [];
  const values = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.has(k)) continue;
    setClauses.push(`${k} = ?`);
    values.push(v);
  }
  if (!setClauses.length) return;
  values.push(id);
  await env.DB.prepare(`UPDATE MenuCategories SET ${setClauses.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function bulkCreateCategories(entries, env) {
  if (!entries.length) return [];
  const stmts = entries.map(e =>
    env.DB.prepare('INSERT OR IGNORE INTO MenuCategories (name, sort_order) VALUES (?, ?)').bind(e.name, e.sortOrder || 0)
  );
  const results = await env.DB.batch(stmts);
  return results.map(r => r.meta.last_row_id);
}

export async function bulkDeleteCategoriesWithItems(categoryIds, env) {
  if (!categoryIds.length) return 0;
  const delItems = categoryIds.map(id => env.DB.prepare('DELETE FROM MenuItems WHERE category_id = ?').bind(id));
  await env.DB.batch(delItems);
  const delCats = categoryIds.map(id => env.DB.prepare('DELETE FROM MenuCategories WHERE id = ?').bind(id));
  const results = await env.DB.batch(delCats);
  return results.filter(r => r.meta.changes > 0).length;
}

export async function moveAllItemsFromCategory(fromCatId, toCatId, env) {
  await env.DB.prepare('UPDATE MenuItems SET category_id = ? WHERE category_id = ?').bind(toCatId, fromCatId).run();
}

export async function bulkMoveItemsToCategory(itemIds, targetCategoryId, env) {
  if (!itemIds.length) return 0;
  const stmts = itemIds.map(id =>
    env.DB.prepare('UPDATE MenuItems SET category_id = ? WHERE id = ?').bind(targetCategoryId, id)
  );
  const results = await env.DB.batch(stmts);
  return results.filter(r => r.meta.changes > 0).length;
}

export async function getItemCountsByCategory(env) {
  const result = await env.DB.prepare(
    'SELECT category_id, COUNT(*) as count FROM MenuItems GROUP BY category_id'
  ).all();
  const map = {};
  for (const row of result.results) map[row.category_id] = row.count;
  return map;
}

export async function getMenuItemsPaginated(env, limit = 8, offset = 0) {
  const result = await env.DB.prepare(
    `SELECT id, name, price, is_available FROM MenuItems ORDER BY name LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();
  
  const count = await env.DB.prepare(`SELECT COUNT(*) as total FROM MenuItems`).first('total');
  
  return { items: result.results, total: count };
}

export async function getActiveOrdersPaginated(env, limit = 8, offset = 0) {
  const result = await env.DB.prepare(
    `SELECT id, user_phone, total_price, status, payment_status, created_at
     FROM Orders
     WHERE status IN ('pending','confirmed','preparing')
     ORDER BY created_at ASC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  const count = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM Orders WHERE status IN ('pending','confirmed','preparing')`
  ).first('total');

  return { orders: result.results, total: count };
}

// ─────────────────────────────────────────────────────────────
// Admin Users
// ─────────────────────────────────────────────────────────────



export async function addAdmin(phone, name, env) {

  await env.DB.prepare(

    'INSERT OR IGNORE INTO AdminUsers (phone_number, name) VALUES (?, ?)'

  ).bind(phone, name || 'Admin').run();

}

