-- Rollback: 20260101000019_add_merchant_display_name_to_users
ALTER TABLE users DROP COLUMN IF EXISTS display_name;
