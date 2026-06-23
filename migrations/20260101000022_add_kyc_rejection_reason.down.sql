-- Rollback: 20260101000022_add_kyc_rejection_reason
ALTER TABLE kyc_applicants DROP COLUMN IF EXISTS rejection_reason;
ALTER TABLE kyc_tier_upgrade_requests DROP COLUMN IF EXISTS rejection_reason;
