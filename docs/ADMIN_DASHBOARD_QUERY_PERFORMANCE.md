# Admin Dashboard Query Performance (#650)

## The problem

The admin dashboard reads the largest tables in the schema — `transactions`,
`disputes`, `daily_pnl_snapshots`, `audit_logs` — with aggregate and filtered
queries. Several of those access patterns had no supporting index, so as the
tables grew the planner fell back to sequential scans and the dashboard slowed
down. The queries themselves were individually well formed, which is exactly
why the cause was hard to see from the application side: nothing in the code
was wrong, the indexes just no longer matched the access pattern.

## 1. EXPLAIN analysis

`AdminDashboardQueryPerformanceService.explainDashboardQueries()` runs
`EXPLAIN (FORMAT JSON, COSTS TRUE)` for every query registered in
`DASHBOARD_QUERIES` and reports:

| Field               | Meaning                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `planCost`          | Top-level cost the planner assigned (unitless, relative — not milliseconds) |
| `analyzeDurationMs` | Wall-clock duration of the EXPLAIN round-trip                               |
| `indexesUsed`       | Indexes the planner actually chose, anywhere in the plan tree               |
| `seqScannedTables`  | Relations reached by a sequential scan                                      |
| `overBudget`        | `planCost` exceeds `DASHBOARD_QUERY_COST_BUDGET`                            |

Each plan is also written to the shared `query_plan_cache` (see
[Automatic Database Optimization](#)), so a cost that drifts upward between runs
is flagged as a plan regression.

A query that fails to analyse is reported with its `error` field rather than
aborting the run — the dashboard must not go down because the analyser did.

### Endpoint

```
GET /api/maintenance/admin-dashboard-queries/plans
```

## 2. Missing index recommendations

`recommendMissingIndexes()` walks the same plans and derives a concrete
`CREATE INDEX CONCURRENTLY` statement for every sequential scan that filters on
a column and costs more than `DASHBOARD_INDEX_MIN_SEQ_SCAN_COST`.

The recommendation comes from the plan the planner _actually chose_, not from a
guess at the schema. Filters it cannot confidently attribute to a column are
ignored, because a wrong column in a `CREATE INDEX` is worse than no
recommendation at all. Duplicates are collapsed by (table, columns).

### Endpoint

```
GET /api/maintenance/admin-dashboard-queries/index-recommendations
```

Response shape:

```json
{
  "data": [
    {
      "table": "transactions",
      "columns": ["status"],
      "createStatement": "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_status ON transactions (status);",
      "reason": "Query \"transactions_status_created\" (GET /api/admin/transactions) scans transactions sequentially (cost 4200.5) filtering on status.",
      "sourceQuery": "transactions_status_created",
      "estimatedCost": 4200.5
    }
  ]
}
```

Apply the statement, then re-run the endpoint: the recommendation disappears
once the planner stops choosing the sequential scan.

## 3. Index creation scripts

Migration `20260928_admin_dashboard_query_indexes` creates the indexes the
dashboard access patterns need, plus two monitoring views.

| Index                                      | Access pattern it serves                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `idx_daily_pnl_snapshots_report_date_desc` | 30-day PnL window scan on the financial dashboard                                        |
| `idx_transactions_reference_created`       | Reference-number search — filter and `(created_at DESC, id DESC)` ordering from one scan |
| `idx_transactions_status_created_id`       | Status-filtered recent-transaction list                                                  |
| `idx_transactions_recent_window`           | 24h volume aggregate; partial, so it stays small                                         |
| `idx_disputes_status_created`              | Open-dispute queue ordering                                                              |
| `idx_audit_logs_user_created`              | Per-user audit-trail reads                                                               |

All statements are `IF NOT EXISTS`, so the migration is idempotent and
re-appliable. The matching `.down.sql` drops the views then the indexes.

To create them by hand instead of running the migration:

```bash
psql "$DATABASE_URL" -f migrations/20260928_admin_dashboard_query_indexes.sql
```

`CONCURRENTLY` is deliberate: it keeps the dashboard readable and writable
while the index is built, at the cost of two table scans.

## 4. Query performance monitoring

`collectQueryPerformanceMetrics()` samples per-table statistics so the
regression is observable rather than only felt.

```
GET /api/maintenance/admin-dashboard-queries/metrics
```

It reports `seqScans`, `seqTuplesRead`, `indexScans`, `liveTuples`,
`deadTuples`, `lastSeqScan`, `unusedIndexes`, and a derived `seqScanRatio` —
the share of accesses that went through a sequential scan. A `seqScanRatio`
climbing towards 1.0 on a dashboard table means the indexes above are not being
used, or the table grew enough that the planner no longer prefers them.

The same data is available in SQL, backed by the views created in the
migration:

```sql
-- Per-table seq-scan ratio and unused indexes
SELECT * FROM v_dashboard_query_seq_scans ORDER BY seq_scan_ratio DESC;

-- Cached dashboard plans currently over budget
SELECT * FROM v_dashboard_query_plans_over_budget;
```

These are built on `pg_stat_user_tables` / `pg_stat_user_indexes` rather than
`pg_stat_statements`, which requires an extension that is not guaranteed to be
installed — a view over a missing relation would fail the whole migration.

Stats are cumulative since the last `pg_stat_reset()`, so compare samples over
time rather than reading a single value as an absolute.

## Configuration

| Variable                            | Default | Purpose                                              |
| ----------------------------------- | ------- | ---------------------------------------------------- |
| `DASHBOARD_QUERY_COST_BUDGET`       | `1000`  | Plan cost above which a query is flagged over budget |
| `DASHBOARD_INDEX_MIN_SEQ_SCAN_COST` | `100`   | Minimum seq-scan cost before an index is recommended |

## Adding a dashboard query

Append an entry to `DASHBOARD_QUERIES` with a `name`, the `route` that issues
it, a `description`, and parameterised `sql`. It is analysed the next time the
endpoints are called — a new dashboard widget is measured from the day it is
added rather than after it starts hurting.
