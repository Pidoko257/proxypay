-- Sensitive-operation audit records and durable user settings.

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  before_state JSONB,
  after_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  admin_id UUID,
  resource TEXT,
  resource_id TEXT,
  diff JSONB
);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_id TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS before_state JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS after_state JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS admin_id UUID;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS resource TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS resource_id TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS diff JSONB;

ALTER TABLE audit_logs ALTER COLUMN admin_id DROP NOT NULL;
ALTER TABLE audit_logs ALTER COLUMN resource DROP NOT NULL;
ALTER TABLE audit_logs ALTER COLUMN diff DROP NOT NULL;

UPDATE audit_logs
   SET user_id = COALESCE(user_id, admin_id::text),
       entity_type = COALESCE(entity_type, resource),
       entity_id = COALESCE(entity_id, resource_id),
       after_state = COALESCE(after_state, diff)
 WHERE user_id IS NULL OR entity_type IS NULL;

ALTER TABLE audit_logs ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE audit_logs ALTER COLUMN entity_type SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'system',
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  toast_density TEXT NOT NULL DEFAULT 'comfortable',
  quiet_mode BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_settings_theme_check CHECK (theme IN ('light', 'dark', 'system')),
  CONSTRAINT user_settings_toast_density_check CHECK (
    toast_density IN ('comfortable', 'compact', 'minimal')
  ),
  CONSTRAINT user_settings_currency_check CHECK (currency ~ '^[A-Z]{3}$')
);
