-- Migration: Create Organization Settings
-- Description: Per-organization configuration settings (currency, notifications,
-- IP allowlist, custom fee tier override) with change audit trail.

CREATE TABLE IF NOT EXISTS organization_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id VARCHAR(255) NOT NULL UNIQUE,
  default_currency VARCHAR(10) NOT NULL DEFAULT 'XAF',
  payment_notification_enabled BOOLEAN NOT NULL DEFAULT true,
  payment_notification_url TEXT,
  ip_allowlist TEXT[] DEFAULT '{}',
  custom_fee_tier_override JSONB DEFAULT '{}',
  created_by VARCHAR(255) NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_settings_org_id ON organization_settings (organization_id);

-- Audit table for settings changes (before/after values)
CREATE TABLE IF NOT EXISTS organization_settings_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id VARCHAR(255) NOT NULL,
  action VARCHAR(20) NOT NULL,
  old_values JSONB,
  new_values JSONB,
  changed_by VARCHAR(255) NOT NULL,
  ip_address INET,
  user_agent TEXT,
  changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_settings_audit_org_id ON organization_settings_audit (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_settings_audit_changed_at ON organization_settings_audit (changed_at DESC);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_organization_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_organization_settings_updated_at
  BEFORE UPDATE ON organization_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_organization_settings_updated_at();
