-- Rollback: 20260101000003_add_2fa_support
DROP TRIGGER IF EXISTS backup_codes_used_at ON backup_codes;
DROP FUNCTION IF EXISTS update_backup_codes_used_at();
DROP TABLE IF EXISTS backup_codes;
DROP INDEX IF EXISTS idx_users_email;
ALTER TABLE users
  DROP COLUMN IF EXISTS two_factor_secret,
  DROP COLUMN IF EXISTS two_factor_enabled,
  DROP COLUMN IF EXISTS two_factor_verified,
  DROP COLUMN IF EXISTS email;
