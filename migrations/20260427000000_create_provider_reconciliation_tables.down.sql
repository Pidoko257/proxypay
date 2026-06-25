-- Rollback: 20260427000000_create_provider_reconciliation_tables
DROP TRIGGER IF EXISTS provider_reconciliation_alerts_updated_at ON provider_reconciliation_alerts;
DROP FUNCTION IF EXISTS update_provider_reconciliation_alerts_updated_at();
DROP TRIGGER IF EXISTS provider_reconciliation_runs_updated_at ON provider_reconciliation_runs;
DROP FUNCTION IF EXISTS update_provider_reconciliation_runs_updated_at();
DROP TRIGGER IF EXISTS provider_report_configs_updated_at ON provider_report_configs;
DROP FUNCTION IF EXISTS update_provider_report_configs_updated_at();
DROP TABLE IF EXISTS provider_reconciliation_alerts;
DROP TABLE IF EXISTS provider_report_configs;
DROP TABLE IF EXISTS provider_reconciliation_runs;
