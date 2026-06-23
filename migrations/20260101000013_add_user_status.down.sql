-- Rollback: 20260101000013_add_user_status
DROP TABLE IF EXISTS user_status_audit;
DROP INDEX IF EXISTS idx_users_status;
ALTER TABLE users DROP COLUMN IF EXISTS status;
