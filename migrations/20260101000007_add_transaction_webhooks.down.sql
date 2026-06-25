-- Rollback: 20260101000007_add_transaction_webhooks
ALTER TABLE transactions
  DROP COLUMN IF EXISTS webhook_delivery_status,
  DROP COLUMN IF EXISTS webhook_last_attempt_at,
  DROP COLUMN IF EXISTS webhook_delivered_at,
  DROP COLUMN IF EXISTS webhook_last_error;
