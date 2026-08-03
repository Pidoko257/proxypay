-- Migration: add optional JSONB topic filters to merchant webhook subscriptions
-- Filters (AND logic): amount_min, currency, provider, status
-- NULL / {} means no filtering — existing subscriptions keep receiving all events.

ALTER TABLE merchant_webhooks
  ADD COLUMN IF NOT EXISTS filters JSONB DEFAULT NULL;

COMMENT ON COLUMN merchant_webhooks.filters IS
  'Optional webhook topic filters (amount_min, currency, provider, status). All specified keys must match (AND). NULL/empty = no filter.';

CREATE INDEX IF NOT EXISTS idx_merchant_webhooks_filters
  ON merchant_webhooks USING GIN (filters)
  WHERE filters IS NOT NULL;
