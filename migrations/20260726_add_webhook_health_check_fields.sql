-- Migration: 20260726_add_webhook_health_check_fields
-- Description: Add disabled_reason and disabled_at columns to merchant_webhooks
--              to support the automated health check job that disables failing endpoints.

ALTER TABLE merchant_webhooks
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT,
  ADD COLUMN IF NOT EXISTS disabled_at     TIMESTAMP;

-- Index to make the health check query fast: we only want active webhooks
-- that have enough delivery history to evaluate.
CREATE INDEX IF NOT EXISTS idx_merchant_webhooks_active
  ON merchant_webhooks (is_active)
  WHERE is_active = TRUE;
