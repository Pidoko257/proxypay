-- Rollback: 20260101000004_add_transaction_metadata
DROP INDEX IF EXISTS idx_transactions_metadata;
ALTER TABLE transactions DROP COLUMN IF EXISTS metadata;
