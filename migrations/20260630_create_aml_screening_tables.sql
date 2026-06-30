-- Migration: 20260630_create_aml_screening_tables
-- Description: Create aml_rules and aml_screening_results tables for
--              the configurable AML screening service with velocity counters.

-- ─── aml_rules ───────────────────────────────────────────────────────────────
-- Each row defines one screening rule.
-- rule_type drives which evaluation logic is used:
--   amount_threshold  – block/flag if transaction amount >= config.threshold_xaf
--   velocity_check    – block/flag if phone number has > config.max_count
--                       transactions within config.window_seconds seconds
--   blacklisted_phone – block/flag if phone_number is in config.numbers[]

CREATE TYPE aml_rule_type AS ENUM (
  'amount_threshold',
  'velocity_check',
  'blacklisted_phone'
);

CREATE TABLE IF NOT EXISTS aml_rules (
  id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type   aml_rule_type   NOT NULL,
  name        VARCHAR(255)    NOT NULL,
  description TEXT,
  -- JSONB payload; schema depends on rule_type (see docs per rule below)
  config      JSONB           NOT NULL DEFAULT '{}',
  enabled     BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aml_rules_rule_type ON aml_rules (rule_type);
CREATE INDEX IF NOT EXISTS idx_aml_rules_enabled   ON aml_rules (enabled);

-- ─── aml_screening_results ───────────────────────────────────────────────────
-- One row per (transaction × rule) evaluation.
-- triggered = TRUE means the rule matched and the transaction was flagged.

CREATE TABLE IF NOT EXISTS aml_screening_results (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID        NOT NULL,   -- FK to transactions.id (soft – no FK for perf)
  rule_id         UUID        NOT NULL,   -- FK to aml_rules.id (soft)
  rule_name       VARCHAR(255) NOT NULL,  -- snapshot of rule name at evaluation time
  rule_type       aml_rule_type NOT NULL, -- snapshot of rule type
  triggered       BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Evaluation details: observed values, thresholds, etc.
  details         JSONB       NOT NULL DEFAULT '{}',
  screened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aml_screening_transaction
  ON aml_screening_results (transaction_id);
CREATE INDEX IF NOT EXISTS idx_aml_screening_rule
  ON aml_screening_results (rule_id);
CREATE INDEX IF NOT EXISTS idx_aml_screening_triggered
  ON aml_screening_results (triggered, screened_at DESC);
CREATE INDEX IF NOT EXISTS idx_aml_screening_screened_at
  ON aml_screening_results (screened_at DESC);

-- Auto-update updated_at on aml_rules
CREATE OR REPLACE FUNCTION update_aml_rules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_aml_rules_updated_at ON aml_rules;
CREATE TRIGGER trg_aml_rules_updated_at
  BEFORE UPDATE ON aml_rules
  FOR EACH ROW EXECUTE FUNCTION update_aml_rules_updated_at();

-- ─── Seed default rules ───────────────────────────────────────────────────────
-- These rules are active from first deployment. Operators can toggle enabled or
-- adjust config via the aml_rules table without code changes.

-- Rule 1: Large single-transaction threshold (1 000 000 XAF)
INSERT INTO aml_rules (rule_type, name, description, config, enabled)
VALUES (
  'amount_threshold',
  'Large Transaction Threshold',
  'Flag any single transaction whose amount meets or exceeds 1 000 000 XAF (approx. $1 500 USD). '
  'Matches the Central Bank of Central African States (BEAC) reporting threshold.',
  '{"threshold_xaf": 1000000}',
  TRUE
)
ON CONFLICT DO NOTHING;

-- Rule 2: Medium single-transaction alert (500 000 XAF) – lower severity flag
INSERT INTO aml_rules (rule_type, name, description, config, enabled)
VALUES (
  'amount_threshold',
  'Elevated Amount Alert',
  'Flag transactions >= 500 000 XAF for enhanced due diligence. '
  'Below the hard reporting threshold but warrants review.',
  '{"threshold_xaf": 500000}',
  TRUE
)
ON CONFLICT DO NOTHING;

-- Rule 3: Velocity check – more than 3 transactions from same phone number in 1 hour
INSERT INTO aml_rules (rule_type, name, description, config, enabled)
VALUES (
  'velocity_check',
  'High-Frequency Velocity Check',
  'Flag when the same phone number initiates more than 3 transactions within a 1-hour '
  'rolling window. Detects rapid structuring or compromised-account abuse.',
  '{"max_count": 3, "window_seconds": 3600}',
  TRUE
)
ON CONFLICT DO NOTHING;

-- Rule 4: Velocity check – more than 10 transactions from same phone in 24 hours
INSERT INTO aml_rules (rule_type, name, description, config, enabled)
VALUES (
  'velocity_check',
  'Daily Velocity Check',
  'Flag when the same phone number initiates more than 10 transactions within 24 hours.',
  '{"max_count": 10, "window_seconds": 86400}',
  TRUE
)
ON CONFLICT DO NOTHING;

-- Rule 5: Blacklisted phone numbers (sample list – replace/extend via DB update)
INSERT INTO aml_rules (rule_type, name, description, config, enabled)
VALUES (
  'blacklisted_phone',
  'Blacklisted Phone Numbers',
  'Reject any transaction from a phone number on the AML blacklist. '
  'The numbers array is managed operationally and updated without a code deployment.',
  '{"numbers": ["+237600000000", "+237611111111", "+237622222222"]}',
  TRUE
)
ON CONFLICT DO NOTHING;

-- ─── Down migration (reference) ──────────────────────────────────────────────
-- To roll back:
--   DROP TABLE IF EXISTS aml_screening_results;
--   DROP TABLE IF EXISTS aml_rules;
--   DROP TYPE  IF EXISTS aml_rule_type;
--   DROP FUNCTION IF EXISTS update_aml_rules_updated_at();
