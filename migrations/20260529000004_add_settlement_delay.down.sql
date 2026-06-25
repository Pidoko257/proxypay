-- Rollback: 20260529000004_add_settlement_delay
DROP INDEX IF EXISTS idx_ledger_entries_settlement_date;
ALTER TABLE ledger_entries DROP COLUMN IF EXISTS settlement_date;
DROP INDEX IF EXISTS idx_users_settlement_delay;
ALTER TABLE users DROP COLUMN IF EXISTS settlement_delay_days;
