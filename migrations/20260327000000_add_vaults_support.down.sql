-- Rollback: 20260327000000_add_vaults_support
DROP INDEX IF EXISTS idx_transactions_vault_id;
ALTER TABLE transactions DROP COLUMN IF EXISTS vault_id;
DROP TABLE IF EXISTS vault_transactions;
DROP TRIGGER IF EXISTS vaults_updated_at ON vaults;
DROP FUNCTION IF EXISTS update_vaults_updated_at();
DROP TABLE IF EXISTS vaults;
