# Add Load Testing Scenarios for Disaster Recovery

## Summary

Adds k6 chaos engineering load tests that simulate provider outages, database failures, and network partitions to validate ProxyPay's recovery behaviour. Includes detailed recovery procedures and acceptance criteria validation.

## Files Added

| File | Purpose |
|------|---------|
| `tests/load/disaster-recovery/chaos-scenarios.js` | Main k6 chaos test — 5 scenarios, custom metrics, DR report |
| `tests/load/disaster-recovery/RECOVERY_PROCEDURES.md` | Step-by-step recovery runbook for each failure type |
| `tests/load/disaster-recovery/results/.gitkeep` | Results directory for test output JSON |

## Chaos Scenarios

### 1. Provider Outage (`-e SCENARIO=provider_outage`)
Simulates MTN/Orange/Airtel mobile money APIs being unavailable.
- **Failure phase**: transactions queued, circuit breaker opens, API returns `202` not `500`
- **Recovery phase**: idempotent re-submission succeeds, queue drains, circuit closes
- **Validates**: graceful degradation via BullMQ queue + opossum circuit breaker

### 2. Database Failure (`-e SCENARIO=db_failure`)
Simulates PostgreSQL primary becoming unreachable (pool exhaustion / failover).
- **Failure phase**: reads served from Redis cache, writes return `503` with `Retry-After`
- **Recovery phase**: pg pool reconnects, idempotent retries confirm no double-writes
- **Validates**: Redis read-path fallback + pg auto-reconnect + no data corruption

### 3. Network Partition (`-e SCENARIO=network_partition`)
Simulates 30% packet loss / split-brain between services.
- **Failure phase**: random request timeouts, non-`500` error responses
- **Recovery phase**: idempotent resubmit with same key succeeds exactly once
- **Validates**: at-least-once delivery without duplicates via idempotency layer

### 4. Full DR (`-e SCENARIO=full_dr`)
Runs all three failure types concurrently across VUs — most realistic scenario.

### 5. Recovery Validation (`-e SCENARIO=recovery_validation`)
Post-incident verification — pure recovery check, no failure injection.

## Custom Metrics

| Metric | Description |
|--------|-------------|
| `chaos_error_rate` | Rate of non-graceful failures (500s, unexpected errors) |
| `recovery_time_ms` | Time from failure phase end to first healthy response |
| `data_loss_events` | Count of idempotent retries that failed (= potential data loss) |
| `retry_success_total` | Idempotent retries that succeeded on recovery |
| `chaos_request_duration_ms` | End-to-end request latency including failure phases |

## Acceptance Criteria Met

- ✅ **Graceful degradation**: API returns 202/503 during failures, never 500
- ✅ **Recovery time < 5 minutes**: `recovery_time_ms` threshold enforced in k6 options
- ✅ **No data loss**: `data_loss_events` counter threshold set to 0
- ✅ **Chaos patterns documented**: `RECOVERY_PROCEDURES.md` covers all 3 failure types + Toxiproxy integration

## Running the Tests

```bash
# Provider outage scenario
k6 run -e SCENARIO=provider_outage tests/load/disaster-recovery/chaos-scenarios.js

# Database failure scenario
k6 run -e SCENARIO=db_failure tests/load/disaster-recovery/chaos-scenarios.js

# Network partition scenario
k6 run -e SCENARIO=network_partition tests/load/disaster-recovery/chaos-scenarios.js

# All scenarios combined
k6 run -e SCENARIO=full_dr tests/load/disaster-recovery/chaos-scenarios.js

# Post-incident recovery validation
k6 run -e SCENARIO=recovery_validation tests/load/disaster-recovery/chaos-scenarios.js
```

Results are written to `tests/load/disaster-recovery/results/dr-summary.json`.

closes #270
