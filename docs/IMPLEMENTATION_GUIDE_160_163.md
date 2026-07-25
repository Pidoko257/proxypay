# Implementation Guide: Issues #160-163

This document provides comprehensive guidance on four critical ProxyPay features implemented in this release.

## Overview

| Issue | Feature | Status | Implementation Time |
|-------|---------|--------|---------------------|
| #160 | Transaction Idempotency Keys (Redis Caching) | ✅ Complete | 1-2 days |
| #161 | Database Migration Tool | ✅ Complete | 3-4 days |
| #162 | Comprehensive Sentry Error Tracking | ✅ Complete | 2-3 days |
| #163 | Database Connection Pooling Monitoring | ✅ Complete | 2-3 days |

---

## #160: Transaction Idempotency Keys (Complete)

### What Was Implemented

A robust idempotency system with Redis caching, UUID validation, and automatic cleanup for safe transaction retries.

### Features

- **Redis Response Caching**: Duplicate requests with the same `Idempotency-Key` return cached responses
- **UUID Validation**: Enforces UUID v4 format for idempotency keys
- **24-hour TTL**: Automatic cache expiration after 24 hours
- **User-scoped Caching**: Separates cache by user ID to prevent cross-user data leaks
- **Middleware Integration**: Automatic request/response caching
- **Successful Response Only**: Only 2xx responses are cached

### Usage

#### Request Header
```bash
POST /api/transactions/deposit
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "amount": 2500,
  "phoneNumber": "+237670000000",
  "provider": "mtn"
}
```

#### Response Headers
```
X-Idempotency-Cached: true (on duplicate requests)
X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

### Code Integration

1. **Add middleware to Express app** (in `src/index.ts`):
```typescript
import { idempotencyMiddleware } from "./middleware/idempotency";

app.use(idempotencyMiddleware);
```

2. **Use in transaction controller** (already implemented):
```typescript
const idempotencyKey = extractIdempotencyKey(req);
// ...
await cacheIdempotencyResponse(idempotencyKey, statusCode, responseBody);
```

### Testing

Run tests:
```bash
npm test -- tests/middleware/idempotency.test.ts
```

### Configuration

- TTL: `IDEMPOTENCY_TTL_SECONDS` (default: 86400 = 24 hours)
- Cache prefix: `idempotency:response`
- Format: UUID v4 (enforced by Zod schema)

---

## #161: Database Migration Tool

### What Was Implemented

A production-grade migration runner with version tracking, distributed locking, dry-run support, and automatic rollback.

### Features

- **Version Tracking Table**: `migrations_run` table tracks applied migrations
- **Distributed Locking**: Redis-based locking prevents concurrent migrations
- **Dry-run Mode**: Preview changes before applying
- **Rollback Support**: Automatic down migrations with safety checks
- **Status Reporting**: Check applied, pending, and failed migrations
- **Both SQL and Code-based**: Extensible for complex transformations
- **CLI Interface**: User-friendly commands for management

### Usage

#### CLI Commands

```bash
# Check migration status
npx ts-node src/scripts/migrationRunner.ts status

# Apply pending migrations
npx ts-node src/scripts/migrationRunner.ts up

# Preview without applying
npx ts-node src/scripts/migrationRunner.ts up --dry-run

# Rollback last N migrations
npx ts-node src/scripts/migrationRunner.ts down 1

# Verbose output
npx ts-node src/scripts/migrationRunner.ts up --verbose
```

#### Programmatic Usage

```typescript
import {
  migrateUp,
  migrateDown,
  getMigrationStatus,
} from "./src/scripts/migrationRunner";

// Apply pending migrations
await migrateUp();

// Rollback last 2 migrations
await migrateDown(2);

// Get status
const status = await getMigrationStatus();
console.log(`Applied: ${status.applied}, Pending: ${status.pending}`);
```

### Migration File Structure

1. **Create forward migration**:
   ```sql
   -- migrations/20260725_add_feature.sql
   CREATE TABLE feature (
     id SERIAL PRIMARY KEY,
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );
   ```

2. **Create rollback migration**:
   ```sql
   -- migrations/20260725_add_feature.down.sql
   DROP TABLE IF EXISTS feature;
   ```

### Database Schema

The `migrations_run` table structure:

```sql
CREATE TABLE migrations_run (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,        -- e.g., "20260725_add_feature"
  version VARCHAR(50) NOT NULL,              -- e.g., "20260725"
  applied_at TIMESTAMP DEFAULT NOW(),
  rolled_back_at TIMESTAMP,
  duration_ms INTEGER,                       -- Execution time
  status VARCHAR(20) DEFAULT 'applied',      -- 'applied', 'failed', 'rolled_back'
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_migrations_version (version),
  INDEX idx_migrations_status (status)
);
```

### Safety Features

- **Atomic Transactions**: Migrations run in transactions; automatic rollback on error
- **Lock Timeouts**: 5-minute lock prevents stuck migrations
- **Dry-run Preview**: See what changes before applying
- **Error Recording**: Failed migrations logged with error messages
- **Rollback Verification**: Requires `.down.sql` file to rollback

### Testing

```bash
npm test -- tests/scripts/migrationRunner.test.ts
```

### Troubleshooting

**Lock already held**: 
```bash
# Release stuck lock manually (use with caution)
redis-cli DEL migration:lock
```

**Migration failed**:
```bash
# Check status and error
npx ts-node src/scripts/migrationRunner.ts status

# Rollback if needed
npx ts-node src/scripts/migrationRunner.ts down 1
```

---

## #162: Comprehensive Sentry Error Tracking

### What Was Implemented

Complete error tracking, monitoring, and alerting system for production errors with contextual data, breadcrumbs, and compliance.

### Features

- **Global Error Handlers**: Captures uncaught exceptions and unhandled rejections
- **Contextual Data**: Automatically attaches userId, transactionId, provider, endpoint
- **Breadcrumb Tracking**: Transaction state, provider API calls, database queries
- **Error Sampling**: Filters 404s, timeouts, and client errors intelligently
- **Error Grouping**: Groups by provider, error type, endpoint for better visibility
- **PII Scrubbing**: Automatic redaction of sensitive data before sending
- **Provider Error Tracking**: Specialized capture for mobile money provider failures
- **Compliance Alerts**: Captures compliance/AML-related errors separately

### Configuration

1. **Initialize Sentry in `src/index.ts`**:
```typescript
import * as Sentry from "@sentry/node";
import { initSentry, initializeGlobalErrorHandlers } from "./services/sentryIntegration";

// Initialize early
initSentry(process.env.SENTRY_DSN || "", process.env.SENTRY_RELEASE);

// Setup global handlers
initializeGlobalErrorHandlers();

// Use Sentry request handler middleware
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.errorHandler());
```

2. **Environment Variables**:
```bash
SENTRY_DSN=https://your-key@sentry.io/project-id
SENTRY_RELEASE=1.0.0
NODE_ENV=production
```

### Usage Examples

#### Capture Error with Context
```typescript
import { captureError } from "./services/sentryIntegration";

try {
  await processTransaction(txn);
} catch (error) {
  captureError(error, {
    userId: user.id,
    transactionId: txn.id,
    provider: "mtn",
    endpoint: "/api/transactions/deposit",
    statusCode: 500,
  }, "error");
}
```

#### Attach Breadcrumbs
```typescript
import {
  addTransactionBreadcrumb,
  addProviderAPIBreadcrumb,
  addDatabaseBreadcrumb,
} from "./services/sentryIntegration";

// Transaction state change
addTransactionBreadcrumb(txn, "completed");

// Provider API call
addProviderAPIBreadcrumb("mtn", "/payment/request", "POST", 200, 500);

// Database query
addDatabaseBreadcrumb("SELECT * FROM transactions WHERE id = $1", 45);
```

#### Capture Provider Error
```typescript
import { captureProviderError } from "./services/sentryIntegration";

try {
  await mobileMoneyService.initiatePayment(payment);
} catch (error) {
  captureProviderError("mtn", error as Error, {
    endpoint: "/payment/request",
    amount: payment.amount,
  });
}
```

#### Capture Compliance Error
```typescript
import { captureComplianceError } from "./services/sentryIntegration";

if (fraudDetectionResult.flagged) {
  captureComplianceError(
    new Error("Transaction flagged for manual review"),
    userId,
    "High-value transaction + rapid succession"
  );
}
```

### Middleware Integration

The error middleware automatically captures context:
```typescript
import { sentryErrorCaptureMiddleware } from "./services/sentryIntegration";

app.use(sentryErrorCaptureMiddleware);
```

### Error Sampling Rules

- **Skip**: 404 errors, timeouts, 400/401/403 client errors
- **Capture**: 5xx errors, provider errors, compliance alerts, database errors

### Testing

```bash
npm test -- tests/services/sentryIntegration.test.ts
```

### Best Practices

1. **Always provide context** when capturing errors
2. **Use breadcrumbs** to trace request flow
3. **Don't capture PII** directly (automatic scrubbing handles it)
4. **Use appropriate severity levels**: fatal > error > warning > info
5. **Group related errors** using fingerprints
6. **Monitor critical errors** via alerts/PagerDuty integration

### Monitoring

- **Dashboard**: https://sentry.io/ (your organization)
- **Alerts**: Configure in Sentry project settings
- **Integration**: PagerDuty/Slack for critical errors

---

## #163: Database Connection Pooling Monitoring

### What Was Implemented

Production-grade connection pool monitoring with metrics, saturation detection, health checks, and tuning recommendations.

### Features

- **Real-time Metrics**: Active, idle, total connections, queue depth
- **Saturation Detection**: Alerts when pool utilization > 80%
- **Prometheus Metrics**: Export pool metrics for monitoring
- **Connection Validation**: Health checks for idle connections
- **Queue Monitoring**: Track queries waiting for connections
- **Load Testing**: k6 scenario for baseline testing
- **Configuration Tuning**: Recommendations based on actual usage
- **Alert System**: Critical alerts at 90% utilization

### Configuration

#### Enable Monitoring (in `src/index.ts`)

```typescript
import { poolMonitoringManager } from "./services/poolMonitoring";
import { pool, replicaPools } from "./config/database";

// Register primary pool
poolMonitoringManager.register(pool, "primary", {
  maxConnections: 1000,
  idleTimeoutMs: 30000,
  saturationThreshold: 80,
  alertThreshold: 90,
});

// Register replica pools
replicaPools.forEach((replicaPool, index) => {
  poolMonitoringManager.register(replicaPool, `replica-${index}`, {
    maxConnections: 50,
    idleTimeoutMs: 30000,
  });
});
```

### Environment Variables

```bash
DB_POOL_MAX_CONNECTIONS=1000
DB_POOL_IDLE_TIMEOUT_MS=30000
DB_POOL_SATURATION_THRESHOLD=80
DB_POOL_ALERT_THRESHOLD=90
```

### Prometheus Metrics

All pool metrics are automatically exported to `/metrics` endpoint:

```
db_pool_active_connections{pool="primary"}
db_pool_idle_connections{pool="primary"}
db_pool_total_connections{pool="primary"}
db_pool_queue_depth{pool="primary"}
db_pool_utilization_percent{pool="primary"}
db_pool_saturation_alerts_total{pool="primary", severity="warning"}
db_pool_connection_errors_total{pool="primary", error_type="timeout"}
db_pool_connection_duration_seconds{pool="primary"}
db_query_duration_seconds{pool="primary", query_type="select"}
```

### Usage

#### Get Current Metrics
```typescript
import { poolMonitoringManager } from "./services/poolMonitoring";

const metrics = poolMonitoringManager.getAllMetrics();
console.log(metrics);
// Output:
// {
//   primary: {
//     activeConnections: 45,
//     idleConnections: 80,
//     totalConnections: 125,
//     queueDepth: 3,
//     utilizationPercent: 4,
//     saturation: false
//   },
//   replica-0: { ... }
// }
```

#### Get Tuning Recommendations
```typescript
const monitor = poolMonitoringManager.getMonitor("primary");
const recommendations = monitor?.getConfigRecommendations();
console.log(recommendations);
```

### Load Testing

Run pool load test against your instance:

```bash
# Set environment
export BASE_URL="http://localhost:3000"
export JWT_TOKEN="your-jwt-token"

# Run test (5 minutes, peak 200 VUs)
k6 run benchmarks/pool-load-test.js

# Results will show latency percentiles and saturation metrics
```

### Grafana Dashboard

Create dashboard with these queries:

```
# Active Connections
db_pool_active_connections

# Utilization Percentage
db_pool_utilization_percent

# Queue Depth
db_pool_queue_depth

# Saturation Alerts (rate)
rate(db_pool_saturation_alerts_total[5m])
```

### Alert Rules

Configure Prometheus alerting:

```yaml
groups:
  - name: database_pool
    rules:
      - alert: PoolSaturation
        expr: db_pool_utilization_percent > 80
        for: 5m
        annotations:
          summary: "DB pool saturation detected"

      - alert: PoolCritical
        expr: db_pool_utilization_percent > 90
        for: 1m
        annotations:
          summary: "DB pool at critical utilization"

      - alert: QueueBacklog
        expr: db_pool_queue_depth > 50
        for: 2m
        annotations:
          summary: "High number of queued connections"
```

### Troubleshooting

**High queue depth**:
- Increase `maxConnections` if under-provisioned
- Check for slow queries blocking connections
- Monitor provider API latency

**Connection timeouts**:
- Reduce `connectionTimeoutMillis` to fail faster
- Increase pool size if saturation detected
- Check network connectivity to database

**Stale connections**:
- Increase `idleTimeoutMillis` to keep connections longer
- Enable connection validation to detect stale connections
- Monitor connection errors in Prometheus

### Testing

```bash
npm test -- tests/services/poolMonitoring.test.ts
```

### Performance Tuning Guide

| Metric | Action |
|--------|--------|
| Utilization > 80% | Increase `max` connections |
| Queue depth spikes | Add connection pooling proxy (PgBouncer) |
| High latency at peaks | Reduce idle timeout or increase replicas |
| Connection errors | Check network, increase connection timeout |

---

## Integration Checklist

- [ ] #162 (Sentry): Initialize in `src/index.ts`, set DSN env var, test error capture
- [ ] #161 (Migrations): Run status check, apply pending migrations, verify tracking table
- [ ] #160 (Idempotency): Add middleware to Express, test with duplicate requests
- [ ] #163 (Pooling): Register pools in `src/index.ts`, setup Grafana dashboard, run load test

## Rollout Plan

1. **Staging**: Deploy and run load tests
2. **Monitoring**: Verify Sentry, Prometheus, and pool metrics
3. **Production**: Deploy with feature flags if needed
4. **Monitoring**: Alert on saturation, track error rate trends

## Support

- Sentry Docs: https://docs.sentry.io/platforms/node/
- Migration Examples: See `/migrations/` directory
- Prometheus: https://prometheus.io/docs/prometheus/latest/querying/basics/
- k6 Load Testing: https://k6.io/docs/getting-started/running-k6/
