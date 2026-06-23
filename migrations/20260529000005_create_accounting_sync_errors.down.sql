-- Rollback: 20260529000005_create_accounting_sync_errors
DROP TRIGGER IF EXISTS accounting_sync_errors_updated_at ON accounting_sync_errors;
DROP FUNCTION IF EXISTS update_accounting_sync_errors_updated_at();
DROP TABLE IF EXISTS accounting_sync_errors;
