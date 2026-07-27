-- Migration: 20260727_hash_api_keys
-- Description: Hash API keys with bcrypt (cost factor 12) and store key prefix and hash.
-- Removes plaintext key column to prevent exposure in database breach.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Ensure api_keys table exists
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  is_active BOOLEAN NOT NULL DEFAULT true,
  permissions INTEGER NOT NULL DEFAULT 15,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  label VARCHAR(255)
);

-- Add key_hash and key_prefix columns
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_prefix VARCHAR(16);

-- Migrate existing plaintext keys to bcrypt hashes (cost 12) and key prefixes (first 8 chars)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'key'
  ) THEN
    UPDATE api_keys
       SET key_hash = crypt(key, gen_salt('bf', 12)),
           key_prefix = LEFT(key, 8)
     WHERE key IS NOT NULL AND (key_hash IS NULL OR key_hash = '');

    -- Remove plaintext key column after hashing
    ALTER TABLE api_keys DROP COLUMN key;
  END IF;
END $$;

-- Create index on key_prefix for fast lookup in requireAuth middleware
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys (key_prefix);

COMMENT ON COLUMN api_keys.key_hash IS 'Bcrypt hash (cost factor 12) of the API key secret';
COMMENT ON COLUMN api_keys.key_prefix IS 'First 8 characters of the API key for index lookup';
