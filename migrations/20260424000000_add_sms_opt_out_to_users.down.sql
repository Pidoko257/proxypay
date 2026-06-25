-- Rollback: 20260424000000_add_sms_opt_out_to_users
ALTER TABLE users DROP COLUMN IF EXISTS sms_opt_out;
