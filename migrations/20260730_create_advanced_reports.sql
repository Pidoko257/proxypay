-- Migration: 20260730_create_advanced_reports
-- Description: Add tables for advanced reporting engine (Issue #205)

-- Scheduled reports
CREATE TABLE IF NOT EXISTS scheduled_reports (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type       VARCHAR(30)  NOT NULL
                      CHECK (report_type IN ('pnl', 'settlement', 'aml', 'kyc_compliance', 'custom')),
  schedule          VARCHAR(20)  NOT NULL CHECK (schedule IN ('once', 'daily', 'weekly', 'monthly')),
  format            VARCHAR(10)  NOT NULL CHECK (format IN ('json', 'csv')),
  parameters        JSONB        NOT NULL DEFAULT '{}',
  deliver_to_email  BOOLEAN      NOT NULL DEFAULT false,
  recipients        JSONB        NOT NULL DEFAULT '[]',
  is_active         BOOLEAN      NOT NULL DEFAULT true,
  next_run_at       TIMESTAMPTZ  NOT NULL,
  last_run_at       TIMESTAMPTZ,
  created_by        UUID         NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_reports_next_run    ON scheduled_reports (next_run_at) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_created_by  ON scheduled_reports (created_by);

-- Report archives (generated reports stored for retrieval and retention)
CREATE TABLE IF NOT EXISTS report_archives (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type   VARCHAR(30)  NOT NULL
                  CHECK (report_type IN ('pnl', 'settlement', 'aml', 'kyc_compliance', 'custom')),
  format        VARCHAR(10)  NOT NULL CHECK (format IN ('json', 'csv')),
  parameters    JSONB        NOT NULL DEFAULT '{}',
  status        VARCHAR(20)  NOT NULL DEFAULT 'ready'
                  CHECK (status IN ('pending', 'generating', 'ready', 'failed', 'archived')),
  payload       JSONB,
  generated_by  UUID         NOT NULL REFERENCES users(id),
  generated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_report_archives_type         ON report_archives (report_type);
CREATE INDEX IF NOT EXISTS idx_report_archives_generated_at ON report_archives (generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_archives_expires_at   ON report_archives (expires_at) WHERE expires_at IS NOT NULL;
