-- Migration: 20260928_admin_dashboard_query_indexes
-- Description: Indexes and monitoring views for admin dashboard query
--              performance (#650).
--
-- Problem this fixes:
--   the admin dashboard reads the largest tables in the schema
--   (transactions, disputes, daily_pnl_snapshots, audit_logs) with aggregate
--   and filtered queries. Several of those access patterns had no supporting
--   index, so as the tables grew the planner fell back to sequential scans and
--   the dashboard slowed down with no obvious cause in the application code.
--
-- This migration:
--   1. Adds the composite / partial indexes the dashboard access patterns need.
--   2. Adds a view exposing per-table seq-scan ratios and unused indexes, so
--      the regression is observable rather than only felt.
--   3. Adds a view listing dashboard query plans above the cost budget, so an
--      operator can tell which query is expensive without running EXPLAIN by
--      hand.
--
-- Every statement is idempotent, so the migration can be re-applied safely.

-- ---------------------------------------------------------------------------
-- 1. Dashboard access-path indexes
-- ---------------------------------------------------------------------------

-- 30-day PnL window scan. The existing idx_daily_pnl_snapshots_report_date
-- covers the equality case, but a DESC scan of a growing table is served
-- better by an index declared in the same direction the query reads it.
CREATE INDEX IF NOT EXISTS idx_daily_pnl_snapshots_report_date_desc
    ON daily_pnl_snapshots (report_date DESC);

-- Reference-number search is an exact-match lookup, but it is always
-- combined with the (created_at DESC, id DESC) ordering, so a composite
-- index lets the planner satisfy both the filter and the sort from one scan.
CREATE INDEX IF NOT EXISTS idx_transactions_reference_created
    ON transactions (reference_number, created_at DESC, id DESC);

-- Status-filtered recent list. idx_transactions_status covers the filter on
-- its own but forces a sort; this composite serves filter + ordering.
CREATE INDEX IF NOT EXISTS idx_transactions_status_created_id
    ON transactions (status, created_at DESC, id DESC);

-- 24h volume aggregate filters purely on created_at. A partial index keeps
-- it small by excluding rows that can never match a "recent" window query.
CREATE INDEX IF NOT EXISTS idx_transactions_recent_window
    ON transactions (created_at DESC)
    WHERE created_at >= '2020-01-01'::timestamptz;

-- Open-dispute queue filters on status and orders by creation time. The join
-- back to transactions is on the primary key, so this index covers the
-- ordering half of the plan.
CREATE INDEX IF NOT EXISTS idx_disputes_status_created
    ON disputes (status, created_at DESC);

-- Admin dashboard reads the audit trail for a single user / resource.
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created
    ON audit_logs (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Sequential-scan monitoring view
-- ---------------------------------------------------------------------------
-- Built on pg_stat_user_tables / pg_stat_user_indexes rather than
-- pg_stat_statements: the latter needs an extension that is not guaranteed to
-- be installed, and a view over a missing relation fails the whole migration.
--
-- seq_scan_ratio near 1.0 on a dashboard table means the indexes created
-- above are not being used, or the table grew enough that the planner no
-- longer prefers them.

CREATE OR REPLACE VIEW v_dashboard_query_seq_scans AS
SELECT
    s.relname                                       AS table_name,
    s.seq_scan                                      AS seq_scans,
    s.seq_tup_read                                  AS seq_tuples_read,
    s.idx_scan                                      AS index_scans,
    s.n_live_tup                                    AS live_tuples,
    s.n_dead_tup                                    AS dead_tuples,
    s.last_seq_scan                                 AS last_seq_scan,
    COALESCE(u.unused_indexes, 0)                   AS unused_indexes,
    CASE
        WHEN (s.seq_scan + s.idx_scan) = 0 THEN 0
        ELSE ROUND(
            s.seq_scan::numeric / (s.seq_scan + s.idx_scan)::numeric, 4
        )
    END                                             AS seq_scan_ratio
FROM pg_stat_user_tables s
LEFT JOIN (
    SELECT relid, COUNT(*)::int AS unused_indexes
      FROM pg_stat_user_indexes
     WHERE idx_scan = 0
     GROUP BY relid
) u ON u.relid = s.relid
WHERE s.relname IN (
    'transactions',
    'disputes',
    'daily_pnl_snapshots',
    'audit_logs',
    'users'
)
ORDER BY s.seq_tup_read DESC;

-- ---------------------------------------------------------------------------
-- 3. Over-budget dashboard plans view
-- ---------------------------------------------------------------------------
-- Reads the query_plan_cache populated by the database optimization service
-- (#482). A dashboard query whose cost exceeds the budget is either missing
-- an index or has suffered a plan regression since it was last cached.

CREATE OR REPLACE VIEW v_dashboard_query_plans_over_budget AS
SELECT
    c.query_fingerprint,
    c.plan_cost,
    c.is_regression,
    c.hit_count,
    c.last_used_at,
    c.created_at
FROM query_plan_cache c
WHERE c.plan_cost IS NOT NULL
  AND c.plan_cost > 1000
ORDER BY c.plan_cost DESC;
