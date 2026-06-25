-- Rollback: 20260529000000_add_transaction_keyset_indexes
DROP INDEX IF EXISTS idx_transactions_created_id;
DROP INDEX IF EXISTS idx_transactions_status_created_id;
DROP INDEX IF EXISTS idx_transactions_user_created_id;
DROP INDEX IF EXISTS idx_transactions_provider_created_id;
