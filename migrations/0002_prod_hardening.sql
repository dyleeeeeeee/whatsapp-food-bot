-- ============================================================
-- Migration 0002 — Production Hardening
-- Apply: wrangler d1 execute food-bot-db --remote --file=migrations/0002_prod_hardening.sql
--
-- FORWARD-ONLY and SAFE TO RE-RUN: every statement is additive
-- and idempotent (CREATE TABLE/INDEX IF NOT EXISTS). This file
-- never alters or drops existing tables/columns, so applying it
-- against an already-provisioned database is a no-op.
--
-- DEPLOY-SAFETY: nothing on the order-placement / payment-confirm
-- critical path depends on this migration. Idempotency reuses the
-- EXISTING 'payment_reference' UNIQUE column on Orders. The new
-- RefundLog table is written best-effort (under try/catch in
-- db.logRefund), so deploying code before this runs degrades
-- gracefully (log + continue) rather than breaking a flow.
-- ============================================================

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
