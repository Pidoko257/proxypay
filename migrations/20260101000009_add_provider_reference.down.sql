-- Rollback: 20260101000009_add_provider_reference
DROP INDEX IF EXISTS idx_transactions_provider_reference;
ALTER TABLE transactions DROP COLUMN IF EXISTS provider_reference;
