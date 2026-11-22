-- Rollback: 20261119_create_transaction_status_history
DROP INDEX IF EXISTS idx_transaction_status_history_tx_created;
DROP TABLE IF EXISTS transaction_status_history;
