/**
 * tests/helpers.mjs — shared mocks for the built-in node:test suite.
 *
 * NOT a test file (no `.test.` in the name) so the runner ignores it.
 * Provides a Map-backed KV and a hand-rolled D1 mock whose prepare/bind/
 * all/first/run/batch surface matches what src/db.js + src/reconcile.js
 * actually consume. Zero new dependencies, no network, no miniflare.
 */

// ─────────────────────────────────────────────────────────────
// Mock KV — Cloudflare KV is eventually consistent; the real bug we
// regression-test (cart clobber) came from a STALE read. To model that
// faithfully we keep a committed store AND let a test hand back a stale
// snapshot via `staleGet`.
// ─────────────────────────────────────────────────────────────
export function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const kv = {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, _opts) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    // Test-only: snapshot the current value so a later put can model a
    // navigation request that read a stale copy and re-persisted it.
    snapshot(key) {
      return store.has(key) ? store.get(key) : null;
    },
  };
  return kv;
}

// ─────────────────────────────────────────────────────────────
// Mock D1 — a tiny SQL-aware fake. It does NOT parse SQL generally; it
// pattern-matches the handful of statements the code under test issues
// and mutates an in-memory `orders` array. Each prepared statement is a
// thin object carrying its sql + bound params; `.all/.first/.run` read the
// shared db state; `.batch` runs statements and emulates the UNIQUE
// constraint on payment_reference that drives idempotency.
// ─────────────────────────────────────────────────────────────
export function makeD1(seed = {}) {
  const db = {
    orders: seed.orders ? seed.orders.map(o => ({ ...o })) : [],
    orderItems: [],
    _nextId: seed.nextId || 1,
    // capture of statements run (for assertions)
    log: [],
  };

  function nextId() {
    const max = db.orders.reduce((m, o) => Math.max(m, o.id || 0), 0);
    db._nextId = Math.max(db._nextId, max + 1);
    const id = db._nextId;
    db._nextId += 1;
    return id;
  }

  // Execute a single prepared statement. Returns { meta, results }.
  function exec(stmt) {
    const sql = stmt.sql.replace(/\s+/g, ' ').trim();
    const p = stmt.params;
    db.log.push({ sql, params: p });

    // INSERT INTO Orders (...) VALUES (...)
    if (/^INSERT INTO Orders/i.test(sql)) {
      // column order in src/db.js createOrder:
      // user_phone, total_price, address, notes, 'pending', payment_reference, payment_url, payment_access_code
      const [userPhone, totalPrice, address, notes, ref, paymentUrl, accessCode] = p;
      // UNIQUE constraint on payment_reference (the existing column reused for idempotency)
      if (ref != null && db.orders.some(o => o.payment_reference === ref)) {
        const e = new Error('D1_ERROR: UNIQUE constraint failed: Orders.payment_reference');
        throw e;
      }
      const id = nextId();
      db.orders.push({
        id,
        user_phone: userPhone,
        total_price: totalPrice,
        status: 'pending',
        address,
        notes,
        payment_status: 'pending',
        payment_reference: ref ?? null,
        payment_url: paymentUrl ?? null,
        payment_access_code: accessCode ?? null,
        paid_at: null,
        created_at: seed.now || '2026-06-27 10:00:00',
        updated_at: seed.now || '2026-06-27 10:00:00',
      });
      db._lastInsertRowid = id;
      return { meta: { last_row_id: id, changes: 1 } };
    }

    // INSERT INTO OrderItems (...) VALUES (last_insert_rowid(), ...)
    if (/^INSERT INTO OrderItems/i.test(sql)) {
      const [menuItemId, name, qty, unitPrice, itemNotes] = p;
      db.orderItems.push({
        id: db.orderItems.length + 1,
        order_id: db._lastInsertRowid,
        menu_item_id: menuItemId,
        name,
        quantity: qty,
        unit_price: unitPrice,
        notes: itemNotes,
      });
      return { meta: { last_row_id: db.orderItems.length, changes: 1 } };
    }

    // markOrderPaidAtomic: UPDATE Orders SET payment_status='paid' ... WHERE id=? AND payment_status != 'paid'
    if (/^UPDATE Orders SET payment_status = 'paid'/i.test(sql)) {
      const [paidAt, id] = p;
      const o = db.orders.find(x => x.id === id && x.payment_status !== 'paid');
      if (o) {
        o.payment_status = 'paid';
        o.paid_at = paidAt;
        return { meta: { changes: 1, last_row_id: id } };
      }
      return { meta: { changes: 0, last_row_id: 0 } };
    }

    // age-out: UPDATE Orders SET payment_status='failed' WHERE payment_status='pending' AND created_at < ...
    if (/^UPDATE Orders SET payment_status = 'failed'/i.test(sql)) {
      let changes = 0;
      for (const o of db.orders) {
        if (o.payment_status === 'pending' && o.__stale) {
          o.payment_status = 'failed';
          changes += 1;
        }
      }
      return { meta: { changes, last_row_id: 0 } };
    }

    // reconcile pending scan: SELECT id, payment_reference, total_price FROM Orders WHERE payment_status='pending' ...
    if (/^SELECT id, payment_reference, total_price FROM Orders/i.test(sql)) {
      const results = db.orders
        .filter(o => o.payment_status === 'pending' && o.payment_reference != null && !o.__tooOld)
        .map(o => ({ id: o.id, payment_reference: o.payment_reference, total_price: o.total_price }));
      return { results };
    }

    // orderPhone lookup
    if (/^SELECT user_phone FROM Orders WHERE id = \?/i.test(sql)) {
      const [id] = p;
      const o = db.orders.find(x => x.id === id);
      return { meta: {}, _first: o ? { user_phone: o.user_phone } : null };
    }

    // getOrderByReference / getOrder explicit-column selects
    if (/^SELECT id, user_phone, total_price/i.test(sql) && /WHERE payment_reference = \?/i.test(sql)) {
      const [ref] = p;
      const o = db.orders.find(x => x.payment_reference === ref);
      return { _first: o || null };
    }

    throw new Error(`mock D1: unhandled SQL: ${sql}`);
  }

  function makeStatement(sql) {
    return {
      sql,
      params: [],
      bind(...args) {
        this.params = args;
        return this;
      },
      async all() {
        const r = exec(this);
        return { results: r.results || [], meta: r.meta || {} };
      },
      async first(col) {
        const r = exec(this);
        const row = '_first' in r ? r._first : (r.results ? r.results[0] : null);
        if (col && row) return row[col];
        return row ?? null;
      },
      async run() {
        const r = exec(this);
        return { meta: r.meta || { changes: 0 }, results: r.results || [] };
      },
    };
  }

  db.prepare = (sql) => makeStatement(sql);
  db.batch = async (stmts) => {
    // D1 batch is a transaction: if any statement throws, none commit.
    // Snapshot, run, restore on failure to emulate atomicity.
    const ordersBackup = db.orders.map(o => ({ ...o }));
    const itemsBackup = db.orderItems.map(i => ({ ...i }));
    const nextBackup = db._nextId;
    const lastBackup = db._lastInsertRowid;
    try {
      const out = [];
      for (const s of stmts) {
        out.push(await s.run());
      }
      return out;
    } catch (err) {
      db.orders = ordersBackup;
      db.orderItems = itemsBackup;
      db._nextId = nextBackup;
      db._lastInsertRowid = lastBackup;
      throw err;
    }
  };

  return db;
}

// ─────────────────────────────────────────────────────────────
// Fetch stub — routes Flutterwave verify + WhatsApp graph calls so
// reconcile/sendText never hit the network. Install via installFetch();
// restore via the returned restore().
// ─────────────────────────────────────────────────────────────
export function installFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => handler(String(url), options);
  return () => {
    globalThis.fetch = original;
  };
}

export function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}
