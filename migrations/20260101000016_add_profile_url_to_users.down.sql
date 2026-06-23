-- Rollback: 20260101000016_add_profile_url_to_users
ALTER TABLE users DROP COLUMN IF EXISTS profile_url;
