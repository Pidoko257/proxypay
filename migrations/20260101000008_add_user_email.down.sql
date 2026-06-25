-- Rollback: 20260101000008_add_user_email
DROP INDEX IF EXISTS idx_users_email;
ALTER TABLE users DROP COLUMN IF EXISTS email;
