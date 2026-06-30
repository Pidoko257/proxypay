-- Migration: Add KYC expiry tracking
-- Description: Add expiry timestamps to users table for KYC lifecycle management

ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_approved_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_expired_at TIMESTAMP;

-- Add indexes for efficient expiry queries
CREATE INDEX IF NOT EXISTS idx_users_kyc_approved_at ON users(kyc_approved_at);

-- Update existing users with kyc_level='full' to have kyc_approved_at set to created_at
UPDATE users 
SET kyc_approved_at = created_at 
WHERE kyc_level = 'full' 
AND kyc_approved_at IS NULL;