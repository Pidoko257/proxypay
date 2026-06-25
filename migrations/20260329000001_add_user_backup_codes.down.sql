-- Rollback: 20260329000001_add_user_backup_codes
DROP INDEX IF EXISTS idx_users_backup_codes;
ALTER TABLE users DROP COLUMN IF EXISTS backup_codes;
