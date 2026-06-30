-- Security Events table for audit and anomaly detection
CREATE TABLE IF NOT EXISTS security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  ip_address INET,
  country_code CHAR(2),
  user_agent TEXT,
  metadata JSONB,
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_at TIMESTAMP,
  acknowledged_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_events_user_id ON security_events(user_id);
CREATE INDEX IF NOT EXISTS idx_security_events_event_type ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_country_code ON security_events(country_code);
CREATE INDEX IF NOT EXISTS idx_security_events_acknowledged ON security_events(acknowledged, created_at DESC);

-- Account Activity Baseline table for tracking historical patterns
CREATE TABLE IF NOT EXISTS account_activity_baseline (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  countries TEXT[] DEFAULT '{}',
  ip_addresses TEXT[] DEFAULT '{}',
  typical_hours JSONB,
  last_updated TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_activity_baseline_user_id ON account_activity_baseline(user_id);