-- Rollback: remove merchant webhook topic filters

DROP INDEX IF EXISTS idx_merchant_webhooks_filters;

ALTER TABLE merchant_webhooks
  DROP COLUMN IF EXISTS filters;
