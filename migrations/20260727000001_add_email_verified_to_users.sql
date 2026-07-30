-- Migration: 20260727000001_add_email_verified_to_users
-- Description: Add email_verified flag and timestamp to users table for
-- Issue #35 (developer email verification).
-- Up migration

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_users_email_verified
  ON users(email_verified);
