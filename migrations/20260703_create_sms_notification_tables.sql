-- Migration: SMS Notification Infrastructure
-- Description: Create tables for SMS notification preferences, tracking, and cost billing
-- Up migration

-- Table: SMS Notification Preferences
-- Stores per-user SMS notification settings and opt-out status
CREATE TABLE IF NOT EXISTS sms_notification_preferences (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  
  -- Notification preferences
  enabled               BOOLEAN     NOT NULL DEFAULT TRUE,
  opt_out               BOOLEAN     NOT NULL DEFAULT FALSE,
  opt_out_at            TIMESTAMP,
  opt_out_reason        VARCHAR(500),
  
  -- Event preferences (which transaction events to notify)
  notify_deposit_success  BOOLEAN   NOT NULL DEFAULT TRUE,
  notify_deposit_failure  BOOLEAN   NOT NULL DEFAULT TRUE,
  notify_withdraw_success BOOLEAN   NOT NULL DEFAULT TRUE,
  notify_withdraw_failure BOOLEAN   NOT NULL DEFAULT TRUE,
  notify_dispute_updates  BOOLEAN   NOT NULL DEFAULT TRUE,
  notify_kyc_updates      BOOLEAN   NOT NULL DEFAULT TRUE,
  
  -- Frequency preferences
  max_sms_per_hour      INT         NOT NULL DEFAULT 5,
  max_sms_per_day       INT         NOT NULL DEFAULT 20,
  
  -- Quiet hours (UTC)
  quiet_hours_start     INT,        -- 0-23 (hour of day)
  quiet_hours_end       INT,        -- 0-23 (hour of day)
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sms_prefs_user_id ON sms_notification_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_sms_prefs_opt_out ON sms_notification_preferences(opt_out);

-- Table: SMS Delivery Tracking
-- Tracks every SMS sent, including delivery status and cost
CREATE TABLE IF NOT EXISTS sms_delivery_tracking (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  transaction_id        UUID        REFERENCES transactions(id) ON DELETE SET NULL,
  
  -- Message details
  phone_number          VARCHAR(20) NOT NULL,
  message_content       TEXT        NOT NULL,
  message_type          VARCHAR(50) NOT NULL,  -- 'transaction_success', 'transaction_failure', 'kyc_update', etc.
  
  -- Delivery status
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending', 'sent', 'delivered', 'failed', 'skipped'
  status_reason         VARCHAR(500),         -- Reason if skipped or failed
  provider              VARCHAR(50) NOT NULL,  -- 'twilio', 'africastalking', etc.
  provider_message_id   VARCHAR(100),
  
  -- Cost tracking
  cost_usd              DECIMAL(10, 6),       -- Cost in USD for this SMS
  currency              VARCHAR(3) DEFAULT 'USD',
  
  -- Retry information
  retry_count           INT         DEFAULT 0,
  last_retry_at         TIMESTAMP,
  max_retries           INT         DEFAULT 3,
  
  -- Timestamps
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at               TIMESTAMP,
  delivered_at          TIMESTAMP,
  failed_at             TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sms_tracking_user_id ON sms_delivery_tracking(user_id);
CREATE INDEX IF NOT EXISTS idx_sms_tracking_transaction_id ON sms_delivery_tracking(transaction_id);
CREATE INDEX IF NOT EXISTS idx_sms_tracking_status ON sms_delivery_tracking(status);
CREATE INDEX IF NOT EXISTS idx_sms_tracking_created_at ON sms_delivery_tracking(created_at);
CREATE INDEX IF NOT EXISTS idx_sms_tracking_provider ON sms_delivery_tracking(provider);
CREATE INDEX IF NOT EXISTS idx_sms_tracking_user_created ON sms_delivery_tracking(user_id, created_at);

-- Table: SMS Rate Limiting (Redis-backed, but also tracked in DB for analytics)
-- Tracks SMS sends per user for rate limiting enforcement
CREATE TABLE IF NOT EXISTS sms_rate_limit_events (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Count window
  hour_window           TIMESTAMP   NOT NULL,  -- Timestamp rounded down to the hour
  count                 INT         NOT NULL DEFAULT 1,
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(user_id, hour_window)
);

CREATE INDEX IF NOT EXISTS idx_sms_rate_limit_user_hour ON sms_rate_limit_events(user_id, hour_window);

-- Table: SMS Cost & Billing
-- Aggregates SMS costs for billing and cost tracking
CREATE TABLE IF NOT EXISTS sms_billing_summary (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        REFERENCES users(id) ON DELETE SET NULL,
  
  -- Billing period
  billing_period_start  TIMESTAMP   NOT NULL,
  billing_period_end    TIMESTAMP   NOT NULL,
  
  -- Aggregated metrics
  sms_count_sent        INT         NOT NULL DEFAULT 0,
  sms_count_delivered   INT         NOT NULL DEFAULT 0,
  sms_count_failed      INT         NOT NULL DEFAULT 0,
  total_cost_usd        DECIMAL(12, 6) NOT NULL DEFAULT 0,
  
  -- Breakdown by type
  transaction_sms       INT         DEFAULT 0,
  kyc_sms               INT         DEFAULT 0,
  alert_sms             INT         DEFAULT 0,
  other_sms             INT         DEFAULT 0,
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finalized_at          TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sms_billing_user_period ON sms_billing_summary(user_id, billing_period_start);
CREATE INDEX IF NOT EXISTS idx_sms_billing_period ON sms_billing_summary(billing_period_start, billing_period_end);

-- Table: SMS Opt-Out History
-- Maintains audit trail of opt-in/opt-out changes
CREATE TABLE IF NOT EXISTS sms_opt_out_history (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  action                VARCHAR(20) NOT NULL,  -- 'opt_out', 'opt_in', 'reactivate'
  reason                VARCHAR(500),
  initiated_by          VARCHAR(20) NOT NULL,  -- 'user', 'system', 'admin'
  metadata              JSONB,                 -- Additional context (IP, user agent, etc.)
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sms_optout_history_user_id ON sms_opt_out_history(user_id);
CREATE INDEX IF NOT EXISTS idx_sms_optout_history_created_at ON sms_opt_out_history(created_at);

-- Trigger: Update sms_notification_preferences updated_at
CREATE OR REPLACE FUNCTION update_sms_preferences_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sms_preferences_updated_at ON sms_notification_preferences;
CREATE TRIGGER sms_preferences_updated_at
  BEFORE UPDATE ON sms_notification_preferences
  FOR EACH ROW EXECUTE FUNCTION update_sms_preferences_updated_at();

-- Trigger: Update sms_billing_summary updated_at
CREATE OR REPLACE FUNCTION update_sms_billing_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sms_billing_updated_at ON sms_billing_summary;
CREATE TRIGGER sms_billing_updated_at
  BEFORE UPDATE ON sms_billing_summary
  FOR EACH ROW EXECUTE FUNCTION update_sms_billing_updated_at();

-- Down migration
-- DROP TRIGGER IF EXISTS sms_billing_updated_at ON sms_billing_summary;
-- DROP TRIGGER IF EXISTS sms_preferences_updated_at ON sms_notification_preferences;
-- DROP FUNCTION IF EXISTS update_sms_billing_updated_at();
-- DROP FUNCTION IF EXISTS update_sms_preferences_updated_at();
-- DROP TABLE IF EXISTS sms_opt_out_history;
-- DROP TABLE IF EXISTS sms_billing_summary;
-- DROP TABLE IF EXISTS sms_rate_limit_events;
-- DROP TABLE IF EXISTS sms_delivery_tracking;
-- DROP TABLE IF EXISTS sms_notification_preferences;
