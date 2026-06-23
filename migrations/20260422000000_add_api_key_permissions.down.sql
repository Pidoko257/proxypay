-- Rollback: 20260422000000_add_api_key_permissions
DROP INDEX IF EXISTS idx_api_keys_permissions;
ALTER TABLE api_keys
  DROP COLUMN IF EXISTS permissions,
  DROP COLUMN IF EXISTS label;
