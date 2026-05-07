-- Migration 001: Add payment fields and BulkActionLogs

-- Add columns to Orders
ALTER TABLE Orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','pending','paid','failed'));
ALTER TABLE Orders ADD COLUMN payment_reference TEXT;
ALTER TABLE Orders ADD COLUMN payment_url TEXT;
ALTER TABLE Orders ADD COLUMN payment_access_code TEXT;
ALTER TABLE Orders ADD COLUMN paid_at TEXT;

-- Create unique index for payment_reference
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_ref ON Orders(payment_reference);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON Orders(payment_status);

-- Create BulkActionLogs table
CREATE TABLE IF NOT EXISTS BulkActionLogs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_phone          TEXT NOT NULL,
  action_type          TEXT NOT NULL,
  target_type          TEXT NOT NULL,
  target_value         TEXT NOT NULL DEFAULT '',
  selected_ids_json    TEXT NOT NULL,
  success_count        INTEGER NOT NULL DEFAULT 0,
  failure_count        INTEGER NOT NULL DEFAULT 0,
  skipped_count        INTEGER NOT NULL DEFAULT 0,
  failure_details_json TEXT NOT NULL DEFAULT '[]',
  notify_customers     INTEGER NOT NULL DEFAULT 0,
  cancellation_reason  TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bulk_logs_admin ON BulkActionLogs(admin_phone);
CREATE INDEX IF NOT EXISTS idx_bulk_logs_created ON BulkActionLogs(created_at);
