-- Migration: 20260730_create_data_exports
-- Description: Add tables for data export functionality (Issue #202)

-- Scheduled export jobs
CREATE TABLE IF NOT EXISTS scheduled_exports (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format            VARCHAR(10)  NOT NULL CHECK (format IN ('csv', 'json', 'pdf')),
  schedule          VARCHAR(20)  NOT NULL CHECK (schedule IN ('once', 'daily', 'weekly', 'monthly')),
  filters           JSONB        NOT NULL DEFAULT '{}',
  deliver_to_email  BOOLEAN      NOT NULL DEFAULT false,
  template_id       VARCHAR(100),
  next_run_at       TIMESTAMPTZ  NOT NULL,
  last_run_at       TIMESTAMPTZ,
  is_active         BOOLEAN      NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_exports_user_id  ON scheduled_exports (user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_exports_next_run ON scheduled_exports (next_run_at) WHERE is_active = true;

-- Export access log for audit trail and GDPR compliance
CREATE TABLE IF NOT EXISTS export_access_log (
  id           BIGSERIAL    PRIMARY KEY,
  user_id      TEXT         NOT NULL,
  format       VARCHAR(10)  NOT NULL,
  filters      JSONB        NOT NULL DEFAULT '{}',
  row_count    INTEGER,
  ip_address   INET,
  accessed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_export_access_log_user_id     ON export_access_log (user_id);
CREATE INDEX IF NOT EXISTS idx_export_access_log_accessed_at ON export_access_log (accessed_at DESC);
