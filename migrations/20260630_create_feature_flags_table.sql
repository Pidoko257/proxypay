-- Feature flags table for per-organization feature toggles
CREATE TABLE IF NOT EXISTS feature_flags (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL,
  flag_name       VARCHAR(255) NOT NULL,
  enabled         BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_organization_flag UNIQUE (organization_id, flag_name)
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_org ON feature_flags(organization_id);
CREATE INDEX IF NOT EXISTS idx_feature_flags_name ON feature_flags(flag_name);
CREATE INDEX IF NOT EXISTS idx_feature_flags_org_name ON feature_flags(organization_id, flag_name);

-- Auto-update updated_at on feature_flags
CREATE OR REPLACE FUNCTION update_feature_flags_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS feature_flags_updated_at ON feature_flags;
CREATE TRIGGER feature_flags_updated_at
  BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION update_feature_flags_updated_at();
