# Security review: admin SQL execution

## Scope

Focused review of `src/routes/admin.ts` for a `raw-query` or `raw_query` endpoint and related request-controlled SQL execution.

## Findings

No raw SQL execution endpoint was found. There is no route to remove, and no request-supplied SQL execution path was identified in the reviewed scope.

The database-related routes use fixed-purpose queries:

- `GET /api/admin/database/replication` reports pool and replication status.
- `GET /api/admin/health` executes the constant `SELECT 1`.
- `GET /api/admin/financial/pnl` and `GET /api/admin/api-keys/scope-usage` use predefined SQL.

The admin authorization checks do not expose arbitrary SQL execution. No vulnerability was identified in the reviewed scope.
