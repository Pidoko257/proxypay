-- Rollback: 20260420000000_add_missing_composite_fk_indexes
DROP INDEX IF EXISTS idx_transactions_vault_user;
DROP INDEX IF EXISTS idx_aml_alerts_transaction_user;
DROP INDEX IF EXISTS idx_aml_review_history_alert_user;
DROP INDEX IF EXISTS idx_transactions_id_user;
