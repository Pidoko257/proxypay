-- Rollback: 20260101000005_create_accounting_tables
DROP TRIGGER IF EXISTS update_accounting_connections_updated_at ON accounting_connections;
DROP TABLE IF EXISTS sync_logs;
DROP TABLE IF EXISTS category_mappings;
DROP TABLE IF EXISTS accounting_connections;
ALTER TABLE transactions DROP COLUMN IF EXISTS fee_category;
