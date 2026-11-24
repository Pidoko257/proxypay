-- Rollback: 20260928_admin_dashboard_query_indexes
-- Drops the monitoring views and then the indexes, in reverse order.

DROP VIEW IF EXISTS v_dashboard_query_plans_over_budget;
DROP VIEW IF EXISTS v_dashboard_query_seq_scans;

DROP INDEX IF EXISTS idx_audit_logs_user_created;
DROP INDEX IF EXISTS idx_disputes_status_created;
DROP INDEX IF EXISTS idx_transactions_recent_window;
DROP INDEX IF EXISTS idx_transactions_status_created_id;
DROP INDEX IF EXISTS idx_transactions_reference_created;
DROP INDEX IF EXISTS idx_daily_pnl_snapshots_report_date_desc;
