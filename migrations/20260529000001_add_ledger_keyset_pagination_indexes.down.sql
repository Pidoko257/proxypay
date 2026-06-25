-- Rollback: 20260529000001_add_ledger_keyset_pagination_indexes
DROP INDEX IF EXISTS idx_ledger_entries_account_keyset;
DROP INDEX IF EXISTS idx_ledger_entries_keyset;
