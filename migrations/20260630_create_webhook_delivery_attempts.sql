-- Migration: create webhook_delivery_attempts table (Issue #98)
-- Stores a record of every manual webhook retry attempt for audit / debugging.

CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  status        TEXT        NOT NULL CHECK (status IN ('enqueued', 'failed')),
  triggered_by  TEXT        NOT NULL DEFAULT 'manual',
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_attempts_event_id
  ON webhook_delivery_attempts (event_id);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_attempts_user_id
  ON webhook_delivery_attempts (user_id);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_attempts_created_at
  ON webhook_delivery_attempts (created_at DESC);
