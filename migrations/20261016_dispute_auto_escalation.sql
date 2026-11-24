-- Migration: 20261016_dispute_auto_escalation
-- Description: Add automatic dispute escalation rules and history tables
--              Support auto-escalation based on transaction amount and dispute age

-- ─── dispute_auto_escalation_rules ───────────────────────────────────────────
-- Stores named escalation rules with amount/age thresholds and target priority

CREATE TABLE IF NOT EXISTS dispute_auto_escalation_rules (
  id                              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name                            VARCHAR(100) NOT NULL UNIQUE,
  enabled                         BOOLEAN      NOT NULL DEFAULT TRUE,
  -- Amount range (in XAF) - null means unbounded
  min_amount                      NUMERIC(15,2),
  max_amount                      NUMERIC(15,2),
  -- Escalate if dispute age (hours) >= this threshold
  age_hours_threshold             NUMERIC(10,2) NOT NULL CHECK (age_hours_threshold >= 0),
  -- Only escalate if current priority matches (null = any priority)
  current_priority                VARCHAR(20),
  -- Priority to escalate to
  new_priority                    VARCHAR(20)  NOT NULL CHECK (new_priority IN ('low', 'medium', 'high', 'critical')),
  -- Prevent infinite escalations per dispute
  max_escalations_per_dispute     INTEGER      NOT NULL DEFAULT 5 CHECK (max_escalations_per_dispute > 0),
  description                     TEXT,
  created_at                      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auto_escalation_rules_enabled
  ON dispute_auto_escalation_rules (enabled)
  WHERE enabled = TRUE;

CREATE OR REPLACE FUNCTION update_auto_escalation_rules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS auto_escalation_rules_updated_at ON dispute_auto_escalation_rules;
CREATE TRIGGER auto_escalation_rules_updated_at
  BEFORE UPDATE ON dispute_auto_escalation_rules
  FOR EACH ROW EXECUTE FUNCTION update_auto_escalation_rules_updated_at();

-- ─── dispute_auto_escalation_history ─────────────────────────────────────────
-- Audit trail of auto-escalation events per dispute

CREATE TABLE IF NOT EXISTS dispute_auto_escalation_history (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id              UUID         NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  rule_id                 UUID         NOT NULL REFERENCES dispute_auto_escalation_rules(id) ON DELETE RESTRICT,
  old_priority            VARCHAR(20)  NOT NULL CHECK (old_priority IN ('low', 'medium', 'high', 'critical')),
  new_priority            VARCHAR(20)  NOT NULL CHECK (new_priority IN ('low', 'medium', 'high', 'critical')),
  transaction_amount      NUMERIC(15,2),
  age_hours               NUMERIC(10,2),
  created_at              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auto_escalation_history_dispute_id
  ON dispute_auto_escalation_history (dispute_id);
CREATE INDEX IF NOT EXISTS idx_auto_escalation_history_rule_id
  ON dispute_auto_escalation_history (rule_id);
CREATE INDEX IF NOT EXISTS idx_auto_escalation_history_created_at
  ON dispute_auto_escalation_history (created_at);

-- ─── Add columns to disputes table ────────────────────────────────────────────
-- Track priority and last auto-escalation time on the dispute itself

ALTER TABLE disputes ADD COLUMN IF NOT EXISTS
  priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical'));

ALTER TABLE disputes ADD COLUMN IF NOT EXISTS
  sla_due_date TIMESTAMP;

ALTER TABLE disputes ADD COLUMN IF NOT EXISTS
  sla_warning_sent BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE disputes ADD COLUMN IF NOT EXISTS
  internal_notes TEXT;

ALTER TABLE disputes ADD COLUMN IF NOT EXISTS
  last_auto_escalated_at TIMESTAMP;

-- Add status values for new states
ALTER TABLE disputes ADD CONSTRAINT disputes_status_extended
  CHECK (status IN ('open', 'investigating', 'resolved', 'rejected', 'reversed', 'upheld'));

CREATE INDEX IF NOT EXISTS idx_disputes_priority
  ON disputes (priority);

CREATE INDEX IF NOT EXISTS idx_disputes_sla_due_date
  ON disputes (sla_due_date)
  WHERE status IN ('open', 'investigating');

CREATE INDEX IF NOT EXISTS idx_disputes_last_auto_escalated_at
  ON disputes (last_auto_escalated_at);
