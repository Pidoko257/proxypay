-- Rollback: 20260428000002_create_reconciliation_tables
DROP TABLE IF EXISTS reconciliation_discrepancies;
DROP TABLE IF EXISTS reconciliation_reports;
DROP TYPE IF EXISTS review_status;
DROP TYPE IF EXISTS discrepancy_type;
DROP TYPE IF EXISTS reconciliation_status;
