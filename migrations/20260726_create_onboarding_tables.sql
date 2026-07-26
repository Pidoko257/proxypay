-- Organizations table for developer onboarding
CREATE TABLE IF NOT EXISTS organizations (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                VARCHAR(255) NOT NULL,
  -- Step 2: Business info
  business_name       VARCHAR(255),
  business_type       VARCHAR(100),
  registration_number VARCHAR(100),
  tax_id              VARCHAR(100),
  address             TEXT,
  city                VARCHAR(100),
  country             VARCHAR(2),
  website             VARCHAR(500),
  industry            VARCHAR(100),
  -- Step 3: Use cases
  use_cases           TEXT[]      DEFAULT '{}',
  created_at          TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_organizations_user_id ON organizations(user_id);

-- Auto-update updated_at on organizations
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

-- Onboarding progress tracking
CREATE TABLE IF NOT EXISTS onboarding_progress (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_step          INTEGER     NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 4),
  step_1_completed_at   TIMESTAMP,
  step_2_completed_at   TIMESTAMP,
  step_3_completed_at   TIMESTAMP,
  step_4_completed_at   TIMESTAMP,
  completed_at          TIMESTAMP,
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_progress_user_id ON onboarding_progress(user_id);

-- Auto-update updated_at on onboarding_progress
CREATE OR REPLACE FUNCTION update_onboarding_progress_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS onboarding_progress_updated_at ON onboarding_progress;
CREATE TRIGGER onboarding_progress_updated_at
  BEFORE UPDATE ON onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION update_onboarding_progress_updated_at();
