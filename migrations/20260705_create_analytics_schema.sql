-- Migration: Analytics Event Tracking and Dashboard Schema
-- Description: Create comprehensive analytics tracking system with events, aggregations, and materialized views
-- Up migration

-- Table: Analytics Events
-- Centralized event tracking for all user actions and system events
CREATE TABLE IF NOT EXISTS analytics_events (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              VARCHAR(100) UNIQUE,  -- Idempotency key
  
  -- Event identification
  event_type            VARCHAR(50) NOT NULL,  -- login, transaction, kyc, withdrawal, deposit, error, etc.
  event_category        VARCHAR(30) NOT NULL,  -- user_action, system, transaction, security, etc.
  event_name            VARCHAR(100) NOT NULL,
  
  -- Entity references
  user_id               UUID        REFERENCES users(id) ON DELETE SET NULL,
  transaction_id        UUID        REFERENCES transactions(id) ON DELETE SET NULL,
  session_id            VARCHAR(100),
  
  -- Event properties (flexible JSONB for extensibility)
  properties            JSONB       DEFAULT '{}',
  
  -- Context
  platform              VARCHAR(50),  -- web, mobile, api, etc.
  ip_address            INET,
  user_agent            TEXT,
  country               VARCHAR(2),   -- ISO-3166-1 alpha-2
  
  -- Custom dimensions
  dimension_1           VARCHAR(100),
  dimension_2           VARCHAR(100),
  dimension_3           VARCHAR(100),
  
  -- Metrics
  value                 DECIMAL(20, 7),
  duration_ms           INT,
  
  -- Timestamps
  event_timestamp       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Retention
  is_archived           BOOLEAN     DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_events_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_user_id ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON analytics_events(event_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_category ON analytics_events(event_category);
CREATE INDEX IF NOT EXISTS idx_events_user_timestamp ON analytics_events(user_id, event_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_txn_id ON analytics_events(transaction_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_event_name ON analytics_events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_country ON analytics_events(country);

-- Table: Daily Aggregations
-- Pre-aggregated daily metrics for fast dashboard queries
CREATE TABLE IF NOT EXISTS analytics_daily_metrics (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_date           DATE        NOT NULL,
  
  -- User metrics
  active_users          INT         DEFAULT 0,
  new_users             INT         DEFAULT 0,
  returning_users       INT         DEFAULT 0,
  
  -- Transaction metrics
  total_transactions    INT         DEFAULT 0,
  total_volume          DECIMAL(20, 7) DEFAULT 0,
  successful_txns       INT         DEFAULT 0,
  failed_txns           INT         DEFAULT 0,
  
  -- Deposits & Withdrawals
  deposit_count         INT         DEFAULT 0,
  deposit_volume        DECIMAL(20, 7) DEFAULT 0,
  withdraw_count        INT         DEFAULT 0,
  withdraw_volume       DECIMAL(20, 7) DEFAULT 0,
  
  -- KYC metrics
  kyc_submitted         INT         DEFAULT 0,
  kyc_approved          INT         DEFAULT 0,
  kyc_rejected          INT         DEFAULT 0,
  
  -- Platform metrics
  login_count           INT         DEFAULT 0,
  error_count           INT         DEFAULT 0,
  avg_session_duration  INT,        -- in seconds
  
  -- Geographic
  countries_active      INT         DEFAULT 0,
  
  -- Breakdown by platform
  web_users             INT         DEFAULT 0,
  mobile_users          INT         DEFAULT 0,
  api_calls             INT         DEFAULT 0,
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(metric_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON analytics_daily_metrics(metric_date DESC);

-- Table: Hourly Metrics
-- High-resolution metrics for recent trending
CREATE TABLE IF NOT EXISTS analytics_hourly_metrics (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_hour           TIMESTAMP   NOT NULL,  -- Hour start timestamp
  
  active_users          INT         DEFAULT 0,
  transactions          INT         DEFAULT 0,
  transaction_volume    DECIMAL(20, 7) DEFAULT 0,
  login_count           INT         DEFAULT 0,
  error_count           INT         DEFAULT 0,
  avg_response_time_ms  INT,
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(metric_hour)
);

CREATE INDEX IF NOT EXISTS idx_hourly_metrics_hour ON analytics_hourly_metrics(metric_hour DESC);

-- Table: User Cohorts
-- Cohort definitions and membership tracking
CREATE TABLE IF NOT EXISTS analytics_cohorts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_name           VARCHAR(100) NOT NULL,
  cohort_type           VARCHAR(30) NOT NULL,  -- acquisition_date, behavior, geography, etc.
  
  -- Cohort definition
  definition            JSONB       NOT NULL,
  filter_criteria       JSONB,      -- How users are grouped
  
  -- Cohort metrics
  user_count            INT         DEFAULT 0,
  created_date          DATE        NOT NULL,
  
  -- Retention tracking
  retention_day_1       INT,
  retention_day_7       INT,
  retention_day_30      INT,
  retention_day_90      INT,
  
  -- Metadata
  description           TEXT,
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cohorts_type ON analytics_cohorts(cohort_type);
CREATE INDEX IF NOT EXISTS idx_cohorts_created_date ON analytics_cohorts(created_date);

-- Table: Cohort Members
-- Track which users belong to which cohorts
CREATE TABLE IF NOT EXISTS analytics_cohort_members (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id             UUID        NOT NULL REFERENCES analytics_cohorts(id) ON DELETE CASCADE,
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Membership tracking
  joined_at             TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at               TIMESTAMP,
  is_active             BOOLEAN     DEFAULT TRUE,
  
  UNIQUE(cohort_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cohort_members_cohort ON analytics_cohort_members(cohort_id);
CREATE INDEX IF NOT EXISTS idx_cohort_members_user ON analytics_cohort_members(user_id);

-- Table: Transaction Funnels
-- Track conversion funnels for transaction flow
CREATE TABLE IF NOT EXISTS analytics_funnels (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  funnel_name           VARCHAR(100) NOT NULL,
  funnel_type           VARCHAR(30) NOT NULL,  -- transaction, kyc, deposit, withdraw, etc.
  
  -- Funnel steps
  steps                 JSONB       NOT NULL,  -- Array of step definitions
  
  -- Metrics
  total_entries         INT         DEFAULT 0,
  completed_count       INT         DEFAULT 0,
  abandoned_count       INT         DEFAULT 0,
  conversion_rate       DECIMAL(5, 2),
  
  -- Breakdown by step
  step_completion_rates JSONB,      -- Object with step-wise conversion rates
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_funnels_type ON analytics_funnels(funnel_type);

-- Table: Funnel Events
-- Track individual user progression through funnels
CREATE TABLE IF NOT EXISTS analytics_funnel_events (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  funnel_id             UUID        NOT NULL REFERENCES analytics_funnels(id) ON DELETE CASCADE,
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Journey tracking
  step_index            INT         NOT NULL,  -- Current step (0-based)
  step_name             VARCHAR(100) NOT NULL,
  
  -- Status
  status                VARCHAR(20) NOT NULL,  -- entered, completed, abandoned
  abandoned_reason      VARCHAR(100),
  
  -- Timing
  entered_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at          TIMESTAMP,
  duration_seconds      INT,
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_funnel_events_funnel ON analytics_funnel_events(funnel_id);
CREATE INDEX IF NOT EXISTS idx_funnel_events_user ON analytics_funnel_events(user_id);
CREATE INDEX IF NOT EXISTS idx_funnel_events_status ON analytics_funnel_events(status);

-- Table: Analytics Segments
-- Dynamic user segments for targeted analysis
CREATE TABLE IF NOT EXISTS analytics_segments (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_name          VARCHAR(100) NOT NULL,
  description           TEXT,
  
  -- Segment definition
  criteria              JSONB       NOT NULL,
  
  -- Metrics
  user_count            INT         DEFAULT 0,
  
  -- Metadata
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: Dashboard Dashboards (metadata)
CREATE TABLE IF NOT EXISTS analytics_dashboards (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_name        VARCHAR(100) NOT NULL UNIQUE,
  description           TEXT,
  
  -- Layout & configuration
  widgets               JSONB       NOT NULL,  -- Widget definitions
  filters               JSONB,      -- Default filters
  
  -- Access control
  is_public             BOOLEAN     DEFAULT FALSE,
  owner_id              UUID        REFERENCES users(id) ON DELETE SET NULL,
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: Analytics Cache
-- Cache for expensive queries to enable sub-second responses
CREATE TABLE IF NOT EXISTS analytics_query_cache (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key             VARCHAR(255) UNIQUE NOT NULL,
  query_type            VARCHAR(50) NOT NULL,
  
  -- Cached data
  result_data           JSONB       NOT NULL,
  result_count          INT,
  
  -- Cache metadata
  expires_at            TIMESTAMP   NOT NULL,
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  hit_count             INT         DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cache_expires ON analytics_query_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_cache_key ON analytics_query_cache(cache_key);

-- Table: Analytics Exports
-- Track data exports for audit and compliance
CREATE TABLE IF NOT EXISTS analytics_exports (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  export_type           VARCHAR(50) NOT NULL,  -- csv, json, parquet, etc.
  
  -- Export metadata
  created_by            UUID        REFERENCES users(id) ON DELETE SET NULL,
  filename              VARCHAR(255),
  file_size_bytes       BIGINT,
  row_count             INT,
  
  -- Data details
  date_range_start      DATE,
  date_range_end        DATE,
  filters_applied       JSONB,
  
  -- Status
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, completed, failed, archived
  error_message         TEXT,
  download_url          TEXT,
  
  -- Retention
  expires_at            TIMESTAMP,
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_exports_user ON analytics_exports(created_by);
CREATE INDEX IF NOT EXISTS idx_exports_status ON analytics_exports(status);
CREATE INDEX IF NOT EXISTS idx_exports_created ON analytics_exports(created_at DESC);

-- Triggers for automatic timestamp management
CREATE OR REPLACE FUNCTION update_analytics_daily_metrics_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS analytics_daily_metrics_updated_at ON analytics_daily_metrics;
CREATE TRIGGER analytics_daily_metrics_updated_at
  BEFORE UPDATE ON analytics_daily_metrics
  FOR EACH ROW EXECUTE FUNCTION update_analytics_daily_metrics_updated_at();

CREATE OR REPLACE FUNCTION update_analytics_hourly_metrics_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS analytics_hourly_metrics_updated_at ON analytics_hourly_metrics;
CREATE TRIGGER analytics_hourly_metrics_updated_at
  BEFORE UPDATE ON analytics_hourly_metrics
  FOR EACH ROW EXECUTE FUNCTION update_analytics_hourly_metrics_updated_at();

-- Materialized View: Transaction Statistics by Day
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_transaction_daily_stats AS
SELECT 
  DATE(event_timestamp) as event_date,
  COUNT(*) as transaction_count,
  COUNT(DISTINCT user_id) as unique_users,
  SUM(CASE WHEN properties->>'status' = 'completed' THEN 1 ELSE 0 END) as completed_count,
  SUM(CASE WHEN properties->>'status' = 'failed' THEN 1 ELSE 0 END) as failed_count,
  SUM((properties->>'amount')::DECIMAL) as total_volume,
  AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE NULL END) as avg_duration_ms
FROM analytics_events
WHERE event_type IN ('transaction', 'deposit', 'withdraw')
GROUP BY DATE(event_timestamp)
ORDER BY event_date DESC;

CREATE INDEX IF NOT EXISTS idx_mv_transaction_date ON mv_transaction_daily_stats(event_date DESC);

-- Materialized View: User Activity Metrics
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_user_activity_metrics AS
SELECT 
  DATE(event_timestamp) as activity_date,
  COUNT(DISTINCT user_id) as active_users,
  COUNT(DISTINCT session_id) as unique_sessions,
  SUM(duration_ms) as total_session_duration_ms
FROM analytics_events
WHERE event_type = 'login'
GROUP BY DATE(event_timestamp)
ORDER BY activity_date DESC;

CREATE INDEX IF NOT EXISTS idx_mv_activity_date ON mv_user_activity_metrics(activity_date DESC);

-- Down migration
-- DROP MATERIALIZED VIEW IF EXISTS mv_user_activity_metrics;
-- DROP MATERIALIZED VIEW IF EXISTS mv_transaction_daily_stats;
-- DROP TRIGGER IF EXISTS analytics_hourly_metrics_updated_at ON analytics_hourly_metrics;
-- DROP TRIGGER IF EXISTS analytics_daily_metrics_updated_at ON analytics_daily_metrics;
-- DROP FUNCTION IF EXISTS update_analytics_hourly_metrics_updated_at();
-- DROP FUNCTION IF EXISTS update_analytics_daily_metrics_updated_at();
-- DROP TABLE IF EXISTS analytics_exports;
-- DROP TABLE IF EXISTS analytics_query_cache;
-- DROP TABLE IF EXISTS analytics_segments;
-- DROP TABLE IF EXISTS analytics_funnel_events;
-- DROP TABLE IF EXISTS analytics_funnels;
-- DROP TABLE IF EXISTS analytics_cohort_members;
-- DROP TABLE IF EXISTS analytics_cohorts;
-- DROP TABLE IF EXISTS analytics_hourly_metrics;
-- DROP TABLE IF EXISTS analytics_daily_metrics;
-- DROP TABLE IF EXISTS analytics_events;
