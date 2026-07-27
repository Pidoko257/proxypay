-- Rollback: 20260727_add_search_vector_to_transactions

DROP TRIGGER IF EXISTS transactions_search_vector_update ON transactions;
DROP FUNCTION IF EXISTS transactions_search_vector_update();
DROP INDEX IF EXISTS idx_transactions_search_vector;
ALTER TABLE transactions DROP COLUMN IF EXISTS search_vector;
