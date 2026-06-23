-- Rollback: 20260423000000_create_double_entry_ledger
DROP FUNCTION IF EXISTS post_transaction(VARCHAR, TEXT, UUID, UUID, JSONB);
DROP TABLE IF EXISTS ledger_entries;
DROP TABLE IF EXISTS accounts;
DROP FUNCTION IF EXISTS update_accounts_updated_at();
