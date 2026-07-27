-- Migration: 20260727_create_organizations_table
-- Description: Create organizations table, add super-admin role, and link API keys to organizations
-- Issue: #47, #53, #188, #190

-- Add super-admin role
INSERT INTO roles (name, description) VALUES
('super-admin', 'Full system administration access including organization management')
ON CONFLICT (name) DO NOTHING;

-- Create organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  settings JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_organizations_created_by ON organizations(created_by);

-- Add organization_id column to api_keys table
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_organization_id ON api_keys(organization_id);

-- Create organization audit logs table
CREATE TABLE IF NOT EXISTS organization_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  performed_by UUID NOT NULL REFERENCES users(id),
  details JSONB DEFAULT '{}',
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_org_audit_logs_organization_id ON organization_audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_audit_logs_performed_by ON organization_audit_logs(performed_by);
CREATE INDEX IF NOT EXISTS idx_org_audit_logs_action ON organization_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_org_audit_logs_created_at ON organization_audit_logs(created_at);

-- Create function to update organizations updated_at
CREATE OR REPLACE FUNCTION update_organizations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organizations_updated_at ON organizations;
CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_organizations_updated_at();