-- ============================================================
-- WhatsApp Food Bot — D1 Schema
-- Run: wrangler d1 execute food-bot-db --file=schema.sql
--
-- SAFE TO RE-RUN: every statement is additive and idempotent
-- (CREATE TABLE/INDEX IF NOT EXISTS, INSERT OR IGNORE). This
-- file never alters or drops existing tables, so re-running it
-- against an already-provisioned database is a no-op.
--
-- NOTE: D1 manages its own SQLite settings. Do not add PRAGMAs
-- here — journal_mode and foreign_keys are D1-controlled and
-- session-level PRAGMAs do not persist across connections.
-- FK enforcement must be tested explicitly per D1 docs.
-- ============================================================

-- ─────────────────────────────────────────
-- Menu Categories
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS MenuCategories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ─────────────────────────────────────────
-- Menu Items
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS MenuItems (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id  INTEGER NOT NULL REFERENCES MenuCategories(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  price        REAL    NOT NULL CHECK(price >= 0),
  image_url    TEXT    NOT NULL DEFAULT '',
  is_available INTEGER NOT NULL DEFAULT 1 CHECK(is_available IN (0,1)),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_category  ON MenuItems(category_id);
CREATE INDEX IF NOT EXISTS idx_items_available ON MenuItems(is_available);

-- ─────────────────────────────────────────
-- Orders
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_phone   TEXT    NOT NULL,
  total_price  REAL    NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','confirmed','preparing','ready','delivered','cancelled')),
  address      TEXT    NOT NULL DEFAULT '',
  notes        TEXT    NOT NULL DEFAULT '',
  
  -- Payment Fields
  payment_status      TEXT    NOT NULL DEFAULT 'unpaid'
                              CHECK(payment_status IN ('unpaid','pending','paid','failed')),
  payment_reference   TEXT    UNIQUE,
  payment_url         TEXT,
  payment_access_code TEXT,
  paid_at             TEXT,

  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_phone  ON Orders(user_phone);
CREATE INDEX IF NOT EXISTS idx_orders_status ON Orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_ref ON Orders(payment_reference);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON Orders(payment_status);

-- ─────────────────────────────────────────
-- Order Items
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS OrderItems (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES Orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER NOT NULL REFERENCES MenuItems(id),
  name         TEXT    NOT NULL,
  quantity     INTEGER NOT NULL CHECK(quantity > 0),
  unit_price   REAL    NOT NULL,
  notes        TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_orderitems_order ON OrderItems(order_id);

-- ─────────────────────────────────────────
-- Admin Users
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS AdminUsers (
  phone_number TEXT NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT 'Admin',
  added_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────
-- Bulk Action Logs
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS BulkActionLogs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_phone          TEXT NOT NULL,
  action_type          TEXT NOT NULL, -- 'set_status', 'set_availability', etc.
  target_type          TEXT NOT NULL, -- 'orders', 'menu_items', etc.
  target_value         TEXT NOT NULL DEFAULT '',
  selected_ids_json    TEXT NOT NULL, -- list of IDs
  success_count        INTEGER NOT NULL DEFAULT 0,
  failure_count        INTEGER NOT NULL DEFAULT 0,
  skipped_count        INTEGER NOT NULL DEFAULT 0,
  failure_details_json TEXT NOT NULL DEFAULT '[]',
  notify_customers     INTEGER NOT NULL DEFAULT 0, -- boolean
  cancellation_reason  TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bulk_logs_admin ON BulkActionLogs(admin_phone);
CREATE INDEX IF NOT EXISTS idx_bulk_logs_created ON BulkActionLogs(created_at);

-- ─────────────────────────────────────────
-- Refund Log
-- Graceful refund/dispute persistence. Written best-effort
-- (under try/catch in db.logRefund), so a missing table never
-- breaks a flow. Not referenced by any critical-path query.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS RefundLog (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER,
  transaction_id TEXT,
  amount         REAL,
  status         TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_refundlog_order ON RefundLog(order_id);

-- ─────────────────────────────────────────
-- Seed Data (safe to re-run)
-- ─────────────────────────────────────────
INSERT OR IGNORE INTO MenuCategories (name, sort_order) VALUES
  ('Burgers',  1),
  ('Sides',    2),
  ('Drinks',   3),
  ('Desserts', 4);

INSERT OR IGNORE INTO MenuItems (category_id, name, description, price, image_url) VALUES
  (1, 'Classic Burger',    'Beef patty, lettuce, tomato, pickles',    8.99,  ''),
  (1, 'Cheese Burger',     'Classic with melted cheddar',             9.99,  ''),
  (1, 'Spicy Burger',      'Jalapeños, sriracha mayo, crispy onions', 10.49, ''),
  (2, 'French Fries',      'Golden crispy fries with sea salt',       3.49,  ''),
  (2, 'Onion Rings',       'Beer-battered onion rings',               3.99,  ''),
  (3, 'Cola',              'Chilled Coca-Cola 330ml',                 1.99,  ''),
  (3, 'Lemonade',          'Fresh squeezed lemonade',                 2.49,  ''),
  (4, 'Chocolate Cake',    'Rich double chocolate slice',             4.99,  ''),
  (4, 'Vanilla Ice Cream', 'Two scoops Madagascar vanilla',           3.49,  '');
