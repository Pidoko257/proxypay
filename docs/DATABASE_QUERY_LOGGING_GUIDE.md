# Database Query Logging & Performance Monitoring Guide

## Overview

ProxyPay now includes comprehensive database query logging with real-time performance monitoring, slow query detection, and optimization recommendations. This guide covers setup, configuration, and best practices.

## Table of Contents

1. [Architecture](#architecture)
2. [Setup & Configuration](#setup--configuration)
3. [Usage](#usage)
4. [Monitoring & Alerts](#monitoring--alerts)
5. [API Endpoints](#api-endpoints)
6. [Performance Optimization](#performance-optimization)
7. [Best Practices](#best-practices)
8. [Troubleshooting](#troubleshooting)

## Architecture

### High-Level Design

```
PostgreSQL Database
    ↓
Query Interceptor
    ├─→ Capture query text
    ├─→ Measure execution time
    ├─→ Track rows affected
    └─→ Capture errors
         ↓
Query Logger Service
    ├─→ Store logs (in-memory, max 10K)
    ├─→ Calculate statistics
    ├─→ Generate alerts
    └─→ Provide analysis
         ↓
Admin API
    ├─→ Query performance endpoints
    ├─→ Statistics & aggregation
    └─→ Optimization suggestions
```

### Components

**Query Logger Service** (`src/services/queryLogger/queryLoggerService.ts`)
- Stores query execution logs
- Calculates performance statistics
- Generates alerts
- Provides analysis & recommendations

**Query Interceptor** (`src/services/queryLogger/queryInterceptor.ts`)
- Hooks into PostgreSQL pool.query()
- Measures query execution time
- Captures query metadata
- Sanitizes sensitive data

**Admin Routes** (`src/routes/admin/queryLoggingRoutes.ts`)
- REST API for query monitoring
- Performance analysis endpoints
- Alert management
- Optimization suggestions

## Setup & Configuration

### Environment Variables

```bash
# Query logging
QUERY_LOG_ENABLED=true                          # Default: true
QUERY_LOG_SLOW_THRESHOLD_MS=1000                # Default: 1000ms
QUERY_LOG_VERY_SLOW_THRESHOLD_MS=5000           # Default: 5000ms
QUERY_LOG_CRITICAL_THRESHOLD_MS=10000           # Default: 10000ms

# Storage
QUERY_LOG_MAX_SIZE=10000                        # Default: 10000 queries
QUERY_LOG_RETENTION_DAYS=7                      # Default: 7 days

# Features
QUERY_LOG_ENABLE_METRICS=true                   # Default: true
QUERY_LOG_ENABLE_ALERTS=true                    # Default: true
QUERY_LOG_ENABLE_ANALYSIS=true                  # Default: true
QUERY_LOG_LOG_PARAMS=false                      # Default: false (security)
QUERY_LOG_LOG_FULL_QUERIES=true                 # Default: false in prod
```

### Initialization

```typescript
import { QueryLoggerService } from "src/services/queryLogger/queryLoggerService";
import { QueryInterceptor, createInterceptedPool } from "src/services/queryLogger/queryInterceptor";
import { pool } from "src/config/database";

// Initialize query logger
const queryLogger = new QueryLoggerService({
  slowQueryThresholdMs: 1000,
  verySlowQueryThresholdMs: 5000,
  enableQueryLogging: true,
  enableAlerting: true,
  enableAnalysis: true,
  maxMemoryLogSize: 10000,
  retentionDays: 7,
  environment: process.env.NODE_ENV as any,
});

// Intercept database pool
const interceptedPool = createInterceptedPool(pool, queryLogger);
```

## Usage

### Basic Query Logging

All queries executed through the intercepted pool are automatically logged.

### Logged Information

For each query, the following is captured:

```typescript
{
  id: "uuid",                    // Unique log ID
  timestamp: 1721991000,         // Unix milliseconds
  query: "SELECT * FROM ...",    // Sanitized query
  queryType: "SELECT",           // Query type
  table: "users",                // Primary table
  tables: ["users", "orders"],   // All tables involved
  durationMs: 1250.45,           // Execution time
  status: "success",             // success|failed|timeout|slow
  rowsAffected: 100,             // Rows affected/returned
  rowsReturned: 50,              // Rows returned
  isSlowQuery: true,             // Exceeds threshold
  isReadOnly: true,              // Read-only query
  userId: "user-123",            // Associated user
  correlationId: "trace-id",     // Distributed tracing
  error: {                       // If failed
    code: "23505",               // PostgreSQL error code
    message: "Duplicate key",    // Error message
    severity: "ERROR"            // Severity
  },
  tags: ["payment", "critical"], // Custom tags
}
```

## Monitoring & Alerts

### Alert Types

1. **Slow Query**: Query exceeds threshold
2. **Query Failure**: Query execution failed
3. **High Error Rate**: Many queries failing
4. **Table Scan**: Potential missing indexes
5. **High Latency**: P95/P99 exceeds threshold

### Alert Severity

- **info**: Informational
- **warning**: Should investigate
- **error**: Requires action
- **critical**: Urgent action needed

## API Endpoints

### GET /api/admin/query-logs

Get recent query logs with optional filtering.

**Query Parameters:**
- `limit` (default: 100) - Number of logs to return
- `status` - Filter by status (success, failed, slow, timeout)
- `type` - Filter by query type (SELECT, INSERT, UPDATE, DELETE)
- `table` - Filter by table name
- `slowOnly` - Only slow queries (true/false)
- `userId` - Filter by user ID

**Response:**
```json
{
  "success": true,
  "count": 100,
  "logs": [
    {
      "id": "uuid",
      "timestamp": 1721991000,
      "query": "SELECT * FROM users WHERE id = ?",
      "durationMs": 1250,
      "status": "slow",
      "table": "users",
      "isSlowQuery": true
    }
  ]
}
```

### GET /api/admin/query-stats

Get aggregate statistics for all queries.

**Response:**
```json
{
  "success": true,
  "count": 1543,
  "stats": [
    {
      "query": "SELECT * FROM transactions WHERE user_id = ?",
      "queryHash": "abc123def456",
      "queryType": "SELECT",
      "executionCount": 1234,
      "averageDurationMs": 125.5,
      "minDurationMs": 50,
      "maxDurationMs": 5000,
      "p50DurationMs": 100,
      "p95DurationMs": 500,
      "p99DurationMs": 2500,
      "successCount": 1200,
      "failureCount": 34,
      "successRate": 0.972,
      "slowQueryCount": 45,
      "slowQueryPercentage": 3.7
    }
  ]
}
```

### GET /api/admin/query-stats/slow

Get slowest queries (top N).

**Query Parameters:**
- `top` (default: 20) - Number of slowest queries

### GET /api/admin/query-stats/table/:table

Get statistics for a specific table.

**Parameters:**
- `table` - Table name

### GET /api/admin/query-analysis

Analyze query performance over time period.

**Query Parameters:**
- `startDate` - ISO-8601 start date
- `endDate` - ISO-8601 end date

### GET /api/admin/query-performance-summary

Get comprehensive performance summary.

**Response:**
```json
{
  "success": true,
  "summary": {
    "period": {
      "startDate": "2024-07-27T00:00:00Z",
      "endDate": "2024-07-28T00:00:00Z"
    },
    "totalQueries": 50000,
    "averageExecutionTime": 125.5,
    "medianExecutionTime": 95,
    "p95ExecutionTime": 500,
    "p99ExecutionTime": 2500,
    "fastQueries": 45000,
    "normalQueries": 4500,
    "slowQueries": 450,
    "verySlowQueries": 50,
    "totalErrors": 12,
    "errorRate": 0.00024,
    "topSlowestQueries": [],
    "topMostFrequentQueries": [],
    "topFailingQueries": [],
    "tableBreakdown": {
      "transactions": {
        "queryCount": 25000,
        "averageTime": 150
      },
      "users": {
        "queryCount": 15000,
        "averageTime": 80
      }
    },
    "criticalIssues": [],
    "recommendations": []
  }
}
```

### GET /api/admin/query-alerts

Get query performance alerts.

**Query Parameters:**
- `unacknowledged` (default: false) - Only unacknowledged alerts

### POST /api/admin/query-alerts/:alertId/acknowledge

Acknowledge a query alert.

### GET /api/admin/query-optimization-suggestions

Get optimization suggestions for slow queries.

### GET /api/admin/query-storage-stats

Get query logger storage statistics.

### POST /api/admin/query-logs/clear

Clear old query logs.

**Body:**
```json
{
  "beforeDate": "2024-07-15T00:00:00Z"  // Optional
}
```

## Performance Optimization

### Identifying Issues

Use the provided endpoints to identify:

1. **Slow Queries**
   - Check `/api/admin/query-stats/slow`
   - Look for queries > 1000ms

2. **Frequent Slow Queries**
   - Check `executionCount` and `averageDurationMs`
   - Focus on high-frequency slow queries first

3. **Failing Queries**
   - Check `/api/admin/query-optimization-suggestions`
   - Review error codes

### Optimization Strategies

### 1. Add Indexes

```sql
-- Identify missing indexes
SELECT query FROM slow_queries WHERE p95_duration > 1000;

-- Add index for WHERE clause
CREATE INDEX idx_users_id ON users(id);

-- Add composite index for JOINs
CREATE INDEX idx_orders_user_created 
  ON orders(user_id, created_at);
```

### 2. Query Optimization

```sql
-- Before: Full table scan
SELECT * FROM transactions 
WHERE user_id = $1;

-- After: Indexed query, specific columns
SELECT id, amount, status, created_at 
FROM transactions 
WHERE user_id = $1;
```

### 3. Connection Pooling

```typescript
// Use pg-bouncer for connection pooling
const pool = new Pool({
  host: "localhost",
  port: 6432, // pg-bouncer port
  max: 100,   // Connection limit
  idleTimeoutMillis: 30000,
});
```

## Best Practices

### 1. Set Realistic Thresholds

```typescript
// Development (more lenient)
QUERY_LOG_SLOW_THRESHOLD_MS=2000

// Production (stricter)
QUERY_LOG_SLOW_THRESHOLD_MS=500
```

### 2. Regular Monitoring

- Check performance summary daily
- Review optimization suggestions weekly
- Act on critical alerts immediately

### 3. Index Maintenance

```sql
-- Regularly analyze query plans
EXPLAIN ANALYZE SELECT * FROM transactions WHERE user_id = $1;

-- Check index usage
SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read 
FROM pg_stat_user_indexes 
ORDER BY idx_tup_read DESC LIMIT 20;
```

### 4. Query Optimization

```sql
-- Use EXPLAIN to analyze
EXPLAIN (ANALYZE, BUFFERS) 
SELECT * FROM orders 
WHERE created_at > NOW() - INTERVAL '7 days'
AND user_id IN (SELECT id FROM users WHERE status = 'active');

-- Check for sequential scans
SELECT schemaname, tablename 
FROM pg_stat_user_tables 
WHERE seq_scan > 100 
ORDER BY seq_scan DESC;
```

### 5. Retention Policy

```bash
# Clear logs older than 30 days
POST /api/admin/query-logs/clear
{
  "beforeDate": "2024-06-27T00:00:00Z"
}
```

## Troubleshooting

### No Queries Being Logged

1. Verify `QUERY_LOG_ENABLED=true`
2. Check that pool is properly intercepted
3. Look for initialization errors in logs

### High Memory Usage

1. Reduce `QUERY_LOG_MAX_SIZE`
2. Decrease `QUERY_LOG_RETENTION_DAYS`
3. Clear old logs manually

### Missing Optimization Suggestions

1. Ensure `QUERY_LOG_ENABLE_ANALYSIS=true`
2. Wait for queries to accumulate
3. Check for errors in analysis service

### Alerts Not Firing

1. Verify `QUERY_LOG_ENABLE_ALERTS=true`
2. Check alert thresholds
3. Review slow query threshold

## Integration with Monitoring

### Prometheus Metrics

```
# Query durations (histogram)
query_duration_seconds_bucket{query_type="select",le="0.1"}
query_duration_seconds_bucket{query_type="select",le="0.5"}
query_duration_seconds_bucket{query_type="select",le="1.0"}

# Query counts
query_total{type="select",status="success"}
query_total{type="select",status="failed"}

# Slow query rate
slow_query_rate{table="users"}
slow_query_rate{table="transactions"}
```

### Grafana Dashboard

Key panels to create:

1. **Query Execution Time Distribution**
   - Histogram of query durations
   - P50, P95, P99 percentiles

2. **Query Counts by Type**
   - Pie chart of SELECT/INSERT/UPDATE/DELETE

3. **Top Slow Queries**
   - Table with slowest queries
   - Execution count and average time

4. **Error Rate**
   - Time series of failure rate
   - Errors by type

5. **Table Performance**
   - Average query time by table
   - Query count by table

## Example: Dashboard Creation

```sql
-- Query for Grafana
SELECT 
  time_bucket('1 minute', timestamp) AS time,
  query_type,
  AVG(duration_ms) as avg_duration,
  MAX(duration_ms) as max_duration,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95
FROM query_logs
GROUP BY time_bucket('1 minute', timestamp), query_type
ORDER BY time DESC;
```

---

## Related Documentation

- [Performance Monitoring](./MONITORING.md)
- [Database Configuration](./DATABASE_CONFIG.md)
- [PostgreSQL Optimization](./POSTGRES_OPTIMIZATION.md)

## Summary

ProxyPay's query logging system provides:

✅ Real-time query monitoring
✅ Automatic slow query detection
✅ Performance statistics & analysis
✅ Optimization recommendations
✅ Alert system for critical issues
✅ Comprehensive REST API
✅ Audit trail for compliance

This enables your team to identify and fix performance bottlenecks before they impact users.
