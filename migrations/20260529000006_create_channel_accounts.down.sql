-- Rollback: 20260529000006_create_channel_accounts
DROP TRIGGER IF EXISTS trg_channel_accounts_updated_at ON channel_accounts;
DROP FUNCTION IF EXISTS update_channel_accounts_updated_at();
DROP TABLE IF EXISTS channel_accounts;
