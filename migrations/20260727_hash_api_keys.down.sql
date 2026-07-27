-- Migration Rollback: 20260727_hash_api_keys
-- Note: Plaintext key values cannot be restored once hashed. Re-adds key column for schema compatibility.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key TEXT;
DROP INDEX IF EXISTS idx_api_keys_key_prefix;
ALTER TABLE api_keys DROP COLUMN IF EXISTS key_hash;
ALTER TABLE api_keys DROP COLUMN IF EXISTS key_prefix;
