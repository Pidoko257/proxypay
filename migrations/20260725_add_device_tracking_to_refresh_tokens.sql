-- Migration: Add device tracking metadata to refresh_token_families — Issue #166
-- Adds: device_id, device_name, issued_at, expires_at, last_used_at, ip_address, user_agent

ALTER TABLE refresh_token_families
  ADD COLUMN IF NOT EXISTS device_id       TEXT,
  ADD COLUMN IF NOT EXISTS device_name     TEXT,
  ADD COLUMN IF NOT EXISTS ip_address      TEXT,
  ADD COLUMN IF NOT EXISTS user_agent      TEXT,
  ADD COLUMN IF NOT EXISTS issued_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS expires_at      TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_used_at    TIMESTAMP;

-- Index for device-scoped queries (list all sessions for a user on a device)
CREATE INDEX IF NOT EXISTS idx_refresh_token_families_device_id
  ON refresh_token_families(user_id, device_id)
  WHERE device_id IS NOT NULL;

-- Index to support expiry-based cleanup jobs
CREATE INDEX IF NOT EXISTS idx_refresh_token_families_expires_at
  ON refresh_token_families(expires_at)
  WHERE expires_at IS NOT NULL;
