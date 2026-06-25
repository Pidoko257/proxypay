-- Rollback: 20260425000000_add_transaction_indexes
DROP INDEX IF EXISTS idx_transactions_provider;
DROP INDEX IF EXISTS idx_transactions_status_created_at;
DROP INDEX IF EXISTS idx_transactions_notes_fts;
DROP INDEX IF EXISTS idx_transactions_phone_number;
DROP INDEX IF EXISTS idx_transactions_amount;
DROP INDEX IF EXISTS idx_transactions_type;
