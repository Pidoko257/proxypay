-- Rollback: 20261101_encrypt_email_phone_pii

COMMENT ON COLUMN users.email IS NULL;
COMMENT ON COLUMN users.phone_number IS NULL;
COMMENT ON COLUMN merchants.email IS NULL;
COMMENT ON COLUMN merchants.phone_number IS NULL;
COMMENT ON COLUMN transactions.phone_number IS NULL;
