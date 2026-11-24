-- Migration: 20261016_dispute_auto_escalation (down)
-- Rollback automatic dispute escalation tables and columns

-- Drop indexes
DROP INDEX IF EXISTS idx_auto_escalation_history_created_at;
DROP INDEX IF EXISTS idx_auto_escalation_history_rule_id;
DROP INDEX IF EXISTS idx_auto_escalation_history_dispute_id;
DROP INDEX IF EXISTS idx_auto_escalation_rules_enabled;
DROP INDEX IF EXISTS idx_disputes_last_auto_escalated_at;
DROP INDEX IF EXISTS idx_disputes_sla_due_date;
DROP INDEX IF EXISTS idx_disputes_priority;

-- Drop triggers
DROP TRIGGER IF EXISTS auto_escalation_rules_updated_at ON dispute_auto_escalation_rules;
DROP FUNCTION IF EXISTS update_auto_escalation_rules_updated_at();

-- Drop history table
DROP TABLE IF EXISTS dispute_auto_escalation_history;

-- Drop rules table
DROP TABLE IF EXISTS dispute_auto_escalation_rules;

-- Drop columns from disputes
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_status_extended;
ALTER TABLE disputes DROP COLUMN IF EXISTS last_auto_escalated_at;
ALTER TABLE disputes DROP COLUMN IF EXISTS internal_notes;
ALTER TABLE disputes DROP COLUMN IF EXISTS sla_warning_sent;
ALTER TABLE disputes DROP COLUMN IF EXISTS sla_due_date;
ALTER TABLE disputes DROP COLUMN IF EXISTS priority;
