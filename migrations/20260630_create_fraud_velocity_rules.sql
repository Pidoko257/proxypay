-- Migration: Fraud Detection Velocity Rules (Issue #109)
-- Creates the database-backed rules table and fraud_alerts audit table.

-- ---------------------------------------------------------------------------
-- fraud_velocity_rules
-- Configuration table for velocity-based fraud detection rules.
-- Rules are loaded at runtime and cached; changes take effect within one
-- request cycle.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fraud_velocity_rules (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL UNIQUE,
  description   TEXT,
  rule_type     TEXT        NOT NULL
                  CHECK (rule_type IN (
                    'multi_destination_velocity',
                    'large_payment_concentration',
                    'structuring_escalation'
                  )),
  -- Window over which the counter is maintained (seconds)
  window_seconds  INTEGER   NOT NULL,
  -- Maximum count before the rule triggers
  threshold       INTEGER   NOT NULL,
  -- Score added to the transaction fraud score when this rule fires
  score           INTEGER   NOT NULL DEFAULT 30,
  is_active       BOOLEAN   NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the three required rules from the issue spec
INSERT INTO fraud_velocity_rules (name, description, rule_type, window_seconds, threshold, score)
VALUES
  (
    'multi_destination_velocity',
    'More than 5 transactions to different destination numbers in 10 minutes from the same API key',
    'multi_destination_velocity',
    600,   -- 10 minutes
    5,
    40
  ),
  (
    'large_payment_concentration',
    'Same destination number receiving more than 3 large payments in 24 hours',
    'large_payment_concentration',
    86400, -- 24 hours
    3,
    35
  ),
  (
    'structuring_escalation',
    'Transaction amounts follow an escalating pattern (structuring detection)',
    'structuring_escalation',
    3600,  -- 1 hour look-back window
    3,     -- minimum sequence length to trigger
    45
  )
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- fraud_alerts
-- One record per rule violation, linked to the flagged transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fraud_alerts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  TEXT        NOT NULL,
  user_id         TEXT,
  rule_id         UUID        REFERENCES fraud_velocity_rules(id),
  rule_name       TEXT        NOT NULL,
  rule_type       TEXT        NOT NULL,
  fraud_score     INTEGER     NOT NULL,
  context         JSONB,
  status          TEXT        NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'reviewed', 'dismissed', 'escalated')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fraud_alerts_transaction_id
  ON fraud_alerts (transaction_id);

CREATE INDEX IF NOT EXISTS idx_fraud_alerts_user_id
  ON fraud_alerts (user_id);

CREATE INDEX IF NOT EXISTS idx_fraud_alerts_rule_name
  ON fraud_alerts (rule_name);

CREATE INDEX IF NOT EXISTS idx_fraud_alerts_status
  ON fraud_alerts (status);

CREATE INDEX IF NOT EXISTS idx_fraud_alerts_created_at
  ON fraud_alerts (created_at DESC);
