-- Migration: Create Organization Payment Limits
-- Description: Configurable per-organization, per-KYC-tier payment limits
-- (daily, weekly, monthly cumulative transaction volume caps).

CREATE TABLE IF NOT EXISTS organization_payment_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id VARCHAR(255) NOT NULL,
  kyc_tier VARCHAR(20) NOT NULL CHECK (kyc_tier IN ('unverified', 'basic', 'full')),
  daily_limit NUMERIC(15,2) NOT NULL CHECK (daily_limit >= 0),
  weekly_limit NUMERIC(15,2) NOT NULL CHECK (weekly_limit >= 0),
  monthly_limit NUMERIC(15,2) NOT NULL CHECK (monthly_limit >= 0),
  created_by VARCHAR(255) NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, kyc_tier)
);

CREATE INDEX IF NOT EXISTS idx_org_payment_limits_org_id ON organization_payment_limits (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_payment_limits_org_tier ON organization_payment_limits (organization_id, kyc_tier);

-- Audit table for limit changes
CREATE TABLE IF NOT EXISTS organization_payment_limits_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  limit_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL,
  old_values JSONB,
  new_values JSONB,
  changed_by VARCHAR(255) NOT NULL,
  ip_address INET,
  user_agent TEXT,
  changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_limits_audit_limit_id ON organization_payment_limits_audit (limit_id);
CREATE INDEX IF NOT EXISTS idx_org_limits_audit_changed_at ON organization_payment_limits_audit (changed_at DESC);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_organization_payment_limits_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_organization_payment_limits_updated_at
  BEFORE UPDATE ON organization_payment_limits
  FOR EACH ROW
  EXECUTE FUNCTION update_organization_payment_limits_updated_at();
