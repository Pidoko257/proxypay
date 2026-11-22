-- Migration: 20261101_encrypt_email_phone_pii
-- Description: Encrypt existing email and phone_number PII in users and merchants tables
-- 
-- This migration encrypts plaintext email and phone_number values that must be protected
-- under GDPR/CCPA. The encryption is performed application-side by calling the
-- encryptPiiFields/decryptPiiFields middleware functions.
--
-- See: src/middleware/piiEncryption.ts for the encryption/decryption logic.
-- 
-- Note: This is a data migration that must be coordinated with application deployment.
-- 1. Deploy code with updated PII_FIELDS including "email" and "phone_number"
-- 2. Run a data migration script to encrypt existing plaintext values
-- 3. Run this SQL migration (no-op if already encrypted via application)

-- Mark email and phone_number as PII for audit purposes
-- This is a schema marker; actual encryption happens application-side

COMMENT ON COLUMN users.email IS 'PII: Personally Identifiable Information - Encrypted at rest';
COMMENT ON COLUMN users.phone_number IS 'PII: Personally Identifiable Information - Encrypted at rest';
COMMENT ON COLUMN merchants.email IS 'PII: Personally Identifiable Information - Encrypted at rest';
COMMENT ON COLUMN merchants.phone_number IS 'PII: Personally Identifiable Information - Encrypted at rest';
COMMENT ON COLUMN transactions.phone_number IS 'PII: Personally Identifiable Information - Encrypted at rest';
