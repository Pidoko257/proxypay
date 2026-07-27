# Request Timeouts

Comprehensive guide to ProxyPay's timeout handling system for provider
requests and blockchain submissions.

---

## Overview

ProxyPay uses a multi-layer timeout system that:

1. **Defines explicit policies** per operation type (provider payment, blockchain
   submission, batch operations, etc.)
2. **Issues slow-request warnings** before the hard timeout fires so operators
   can detect degradation early
3. **Returns graceful 408 responses** with retry guidance when a hard timeout
   occurs
4. **Records every timeout event** to a database table for historical analysis
5. **Fires PagerDuty alerts** when the per-minute timeout rate crosses a
   configurable threshold
6. **Attempts partial recovery** after a provider payment or blockchain
   submission times out — because the remote party may have processed the
   request successfully

---

## Architecture

```
Request arrives
      │
      ▼
adaptiveTimeout() middleware
  ├── infers OperationType from path + method
  ├── starts soft-warning timer  (warningThresholdMs)
  └── starts hard-timeout timer  (timeoutMs)
        │
        ├── [normal finish]  → cancel timers, record duration
        │
        └── [hard timeout fires]
              ├── log error + Prometheus counter
              ├── TimeoutService.recordTimeout()
              │     ├── ring-buffer (in-process)
              │     ├── persist to timeout_stats table
              │     └── check alert threshold → PagerDuty
              ├── send 408 JSON response
              └── [if enablePartialRecovery=true]
                    └── TransactionRecoveryService.attemptRecovery()
                          ├── PROVIDER_PAYMENT  → poll provider status API
                          ├── BLOCKCHAIN_SUBMIT → query Stellar Horizon
                          └── BATCH_OPERATION   → mark parent as pending
```

---

## Operation Types and Policies

Each request is classified into an `OperationType` and given a dedicated
policy.  Values can be overridden per-environment (see
[Environment Variables](#environment-variables)).

| Operation Type       | Timeout   | Warning   | Retries | Recovery | Alert |
|----------------------|-----------|-----------|---------|----------|-------|
| `HEALTH_CHECK`       | 5 s       | 2 s       | 1       | ✗        | ✗     |
| `AUTH`               | 10 s      | 3 s       | 1       | ✗        | ✗     |
| `READ`               | 10 s      | 5 s       | 2       | ✗        | ✗     |
| `WRITE`              | 15 s      | 8 s       | 2       | ✗        | ✗     |
| `PROVIDER_STATUS`    | 15 s      | 8 s       | 3       | ✗        | ✗     |
| `BLOCKCHAIN_READ`    | 20 s      | 10 s      | 3       | ✗        | ✗     |
| `DEFAULT`            | 30 s      | 15 s      | 2       | ✗        | ✗     |
| `STELLAR_SEP`        | 30 s      | 15 s      | 2       | ✗        | ✗     |
| `WEBHOOK_DELIVERY`   | 30 s      | 15 s      | 3       | ✗        | ✗     |
| `WEBSOCKET`          | 45 s      | 30 s      | 1       | ✗        | ✗     |
| `PROVIDER_PAYMENT`   | 60 s      | 30 s      | 3       | ✓        | ✓     |
| `KYC`                | 60 s      | 30 s      | 2       | ✗        | ✓     |
| `REPORT_GENERATION`  | 120 s     | 60 s      | 1       | ✗        | ✗     |
| `BATCH_OPERATION`    | 180 s     | 120 s     | 1       | ✓        | ✓     |
| `BLOCKCHAIN_SUBMIT`  | 90 s      | 45 s      | 2       | ✓        | ✓     |

> **Recovery** — whether a timed-out request triggers the partial-recovery
> workflow.  **Alert** — whether a timeout fires a PagerDuty incident.

---

## Middleware Usage

### Global adaptive timeout (recommended)

Mount once at the top of your Express app.  The middleware auto-detects the
operation type from the request path and method:

```typescript
import { adaptiveTimeout } from "./middleware/timeout";

app.use(adaptiveTimeout());
```

### Per-route override

Pin a specific operation type when the path cannot be auto-detected:

```typescript
import { operationTimeout } from "./middleware/timeout";
import { OperationType } from "./utils/timeoutPolicies";

// Stellar submission — use the longer blockchain policy
router.post(
  "/internal/submit-tx",
  operationTimeout(OperationType.BLOCKCHAIN_SUBMIT),
  handler,
);
```

### Legacy connect-timeout API (backwards compatible)

The original `globalTimeout`, `haltOnTimedout`, `timeoutErrorHandler`, and
`TimeoutPresets` exports are preserved:

```typescript
import {
  globalTimeout,
  haltOnTimedout,
  timeoutErrorHandler,
  TimeoutPresets,
  customTimeout,
} from "./middleware/timeout";

app.use(globalTimeout);          // 30 s global
app.use(haltOnTimedout);

router.post("/deposit", TimeoutPresets.long, haltOnTimedout, handler);
router.post("/custom",  customTimeout(45_000), haltOnTimedout, handler);

app.use(timeoutErrorHandler);    // returns 408
```

---

## Timeout Response Format

```json
{
  "error": "Request Timeout",
  "message": "The Provider Payment operation timed out after 60000ms",
  "code": "REQUEST_TIMEOUT",
  "operationType": "PROVIDER_PAYMENT",
  "retryAfter": 60
}
```

HTTP Status: `408 Request Timeout`

The `retryAfter` field (seconds) should be respected by clients before
re-sending the request.

---

## Partial Recovery

When a `PROVIDER_PAYMENT`, `BLOCKCHAIN_SUBMIT`, or `BATCH_OPERATION` times
out, the system automatically attempts to determine the true outcome.

### PROVIDER_PAYMENT recovery

Calls the provider's transaction-status endpoint using the original reference
ID.  If the provider confirms success, the transaction is updated to
`completed`; if still pending, it stays `pending`; if failed/unknown, no
change is made.

### BLOCKCHAIN_SUBMIT recovery

Queries Stellar Horizon for the transaction hash.  If found and `successful`,
the transaction is marked `completed`.  A 404 from Horizon means the
transaction never landed.

### BATCH_OPERATION recovery

The parent batch is marked `pending` so the batch worker can re-process only
the unconfirmed items on its next run.

### Manual recovery trigger

Recovery can also be triggered manually via the API:

```bash
POST /api/timeouts/recover
Authorization: Bearer <token>
Content-Type: application/json

{
  "transactionId": "uuid-here",
  "referenceId": "provider-ref-123",
  "provider": "mtn",
  "operationType": "PROVIDER_PAYMENT",
  "elapsedMs": 62000
}
```

---

## Statistics Dashboard API

| Endpoint | Description |
|---|---|
| `GET /api/timeouts/stats` | Live in-memory stats (last ~1 000 events) |
| `GET /api/timeouts/stats/history?hours=24` | DB-backed historical aggregates |
| `GET /api/timeouts/policies` | All configured timeout policies (public) |
| `POST /api/timeouts/recover` | Manual recovery trigger |

### Example: live stats

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/timeouts/stats
```

```json
{
  "success": true,
  "data": {
    "totalTimeouts": 42,
    "byOperationType": {
      "PROVIDER_PAYMENT": 30,
      "BLOCKCHAIN_SUBMIT": 12
    },
    "last5MinTimeouts": 3,
    "lastHourTimeouts": 18,
    "avgElapsedMs": 64200,
    "topPaths": [
      { "path": "/api/transactions/deposit", "count": 27 },
      { "path": "/api/transactions/withdraw", "count": 3 }
    ],
    "alertThresholdPerMinute": 5,
    "alertActive": false,
    "lastTimeoutAt": "2026-07-27T13:00:01.000Z"
  }
}
```

---

## Alerting

The `TimeoutService` runs a background monitor that checks the last-60-second
timeout count every `TIMEOUT_ALERT_CHECK_INTERVAL_MS` milliseconds.

- When the count reaches `TIMEOUT_ALERT_THRESHOLD_PER_MIN`, a PagerDuty
  **critical** incident is triggered.
- When the count drops back below the threshold, the incident is automatically
  resolved.

Only operation types with `alertOnTimeout: true` are eligible
(`PROVIDER_PAYMENT`, `BLOCKCHAIN_SUBMIT`, `KYC`, `BATCH_OPERATION`).

---

## Database Tables

### `timeout_stats`

Stores every hard-timeout event for historical analysis.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `operation_type` | VARCHAR(64) | OperationType enum value |
| `request_path` | VARCHAR(512) | Request path |
| `http_method` | VARCHAR(10) | HTTP verb |
| `elapsed_ms` | INTEGER | Duration before timeout (ms) |
| `request_id` | VARCHAR(128) | Correlation ID |
| `transaction_id` | UUID | Related transaction (nullable) |
| `occurred_at` | TIMESTAMPTZ | When the timeout occurred |

### `timeout_recovery_log`

Records every partial-recovery attempt.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `operation_type` | VARCHAR(64) | OperationType |
| `transaction_id` | UUID | Related transaction (nullable) |
| `reference_id` | VARCHAR(255) | Provider reference (nullable) |
| `provider` | VARCHAR(64) | Provider name (nullable) |
| `stellar_tx_hash` | VARCHAR(128) | Stellar tx hash (nullable) |
| `elapsed_ms` | INTEGER | Duration before timeout (ms) |
| `recovery_status` | VARCHAR(32) | CONFIRMED / NOT_FOUND / RECOVERY_ERROR / NOT_APPLICABLE / PENDING |
| `message` | TEXT | Human-readable outcome |
| `occurred_at` | TIMESTAMPTZ | When the original timeout occurred |
| `recovered_at` | TIMESTAMPTZ | When recovery completed |

Run the migration to create these tables:

```bash
npm run migrate:up
```

---

## Prometheus Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `request_timeout_total` | Counter | `operation_type`, `method` | Hard timeouts |
| `request_slow_total` | Counter | `operation_type` | Slow-warning crossings |
| `request_timeout_duration_seconds` | Histogram | `operation_type` | Request durations |
| `timeout_recovery_total` | Counter | `operation_type`, `status` | Recovery attempts |

---

## Environment Variables

All timeout values can be overridden without code changes:

```env
# Global fallback (legacy)
REQUEST_TIMEOUT_MS=30000

# Per-operation overrides (replace TYPE with enum name, e.g. PROVIDER_PAYMENT)
TIMEOUT_<TYPE>_MS=60000
TIMEOUT_<TYPE>_WARNING_MS=30000
TIMEOUT_<TYPE>_MAX_RETRIES=3
TIMEOUT_<TYPE>_BASE_DELAY_MS=2000

# Alerting
TIMEOUT_ALERT_THRESHOLD_PER_MIN=5
TIMEOUT_ALERT_CHECK_INTERVAL_MS=60000
```

### Examples

```env
# Give blockchain submissions 2 minutes on a slow network
TIMEOUT_BLOCKCHAIN_SUBMIT_MS=120000

# Reduce provider payment timeout in a fast environment
TIMEOUT_PROVIDER_PAYMENT_MS=30000

# Alert if more than 3 timeouts happen in 1 minute
TIMEOUT_ALERT_THRESHOLD_PER_MIN=3
```

---

## Client-Side Guidance

### Discover server timeouts at runtime

```typescript
const { data: policies } = await fetch("/api/timeouts/policies").then(r => r.json());
const paymentPolicy = policies.find(p => p.operationType === "PROVIDER_PAYMENT");
// paymentPolicy.policy.timeoutMs === 60000
```

### Handle 408 responses

```typescript
const response = await fetch("/api/transactions/deposit", {
  method: "POST",
  body: JSON.stringify(payload),
  headers: { "Content-Type": "application/json" },
  signal: AbortSignal.timeout(65_000), // slightly above server timeout
});

if (response.status === 408) {
  const body = await response.json();
  const retryAfter = body.retryAfter ?? 60; // seconds
  // Wait then check transaction status before retrying
  await sleep(retryAfter * 1000);
  const status = await checkTransactionStatus(transactionId);
  if (status === "completed") return; // server recovered it
  // safe to retry
}
```

> **Important**: always check the transaction status before retrying a
> `PROVIDER_PAYMENT` or `BLOCKCHAIN_SUBMIT` — partial recovery may have
> confirmed the operation succeeded.

---

## Monitoring Recommendations

- Set up a Grafana alert on `request_timeout_total` counter rate > 0.1/min for
  `PROVIDER_PAYMENT` or `BLOCKCHAIN_SUBMIT`.
- Use `request_timeout_duration_seconds` p99 to detect provider SLA
  degradation before the hard timeout fires.
- Monitor `timeout_recovery_total{status="RECOVERY_ERROR"}` — a spike
  indicates both the primary operation and the recovery check are failing,
  which may mean the provider API is completely down.
- Review `GET /api/timeouts/stats/history?hours=24` in your ops runbook after
  any incident.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Legitimate requests returning 408 | Timeout too short | Increase `TIMEOUT_<TYPE>_MS` |
| 408 returned but provider processed the payment | Recovery not firing | Check `enablePartialRecovery=true` for the operation type |
| High `RECOVERY_ERROR` rate | Provider status API unavailable | Check provider health, open incident |
| Alert fires repeatedly | Persistent provider degradation | Increase `TIMEOUT_ALERT_THRESHOLD_PER_MIN` or open provider incident |
| `timeout_stats` table not found | Migration not run | Run `npm run migrate:up` |

---

## Related Documentation

- [`docs/TIMEOUT_QUICK_START.md`](./TIMEOUT_QUICK_START.md) — 5-minute setup guide
- [`docs/PAGERDUTY_INTEGRATION.md`](./PAGERDUTY_INTEGRATION.md) — configuring alerts
- [`src/utils/timeoutPolicies.ts`](../src/utils/timeoutPolicies.ts) — policy definitions
- [`src/middleware/timeout.ts`](../src/middleware/timeout.ts) — middleware implementation
- [`src/services/timeoutService.ts`](../src/services/timeoutService.ts) — alerting & stats
- [`src/services/transactionRecovery.ts`](../src/services/transactionRecovery.ts) — recovery logic
- [`migrations/20260727_create_timeout_stats.sql`](../migrations/20260727_create_timeout_stats.sql) — DB schema
