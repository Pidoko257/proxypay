-- Migration: create passkey_credentials
-- Stores WebAuthn/FIDO2 public key credentials for developer accounts.

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id       TEXT NOT NULL UNIQUE,  -- base64url-encoded credential ID
  public_key          TEXT NOT NULL,          -- base64url-encoded COSE public key
  counter             BIGINT NOT NULL DEFAULT 0,
  device_type         TEXT NOT NULL DEFAULT 'unknown',  -- 'singleDevice' | 'multiDevice'
  backed_up           BOOLEAN NOT NULL DEFAULT FALSE,
  transports          TEXT[],                -- e.g. {'usb','nfc','ble','internal'}
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at        TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_passkey_user_id       ON passkey_credentials (user_id);
CREATE INDEX IF NOT EXISTS idx_passkey_credential_id ON passkey_credentials (credential_id);
