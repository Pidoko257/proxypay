# ProxyPay Disaster Recovery Procedures

> This document describes failure scenarios tested by `chaos-scenarios.js`, expected system behaviour, and step-by-step recovery procedures for each failure type.

## Overview

ProxyPay implements the following resilience mechanisms:
- **Circuit breakers** on provider API calls (opossum)
- **Message queues** (BullMQ/RabbitMQ) for durable transaction processing
- **Idempotency keys** on all write endpoints to prevent double-processing
- **Redis caching** for read-path availability during DB unavailability
- **Health and readiness endpoints** for load balancer orchestration

---

## Failure Scenario 1 — Mobile Money Provider Outage

### What is simulated
All requests to MTN / Orange / Airtel mobile money APIs fail (timeout or 503).

### Expected system behaviour
| Phase | Expected |
|-------|----------|
| Failure begins | Circuit breaker opens after 5 consecutive failures |
| During outage | API returns `202 Accepted` — transaction queued for retry |
| Queue | BullMQ retries with exponential backoff (max 5 attempts) |
| Recovery | Circuit breaker half-opens, probes provider, closes on success |
| Post-recovery | Queued transactions processed; idempotent re-submissions ignored |

### Recovery SLA
- Detection: < 30 seconds (circuit breaker threshold)
- Automatic recovery: < 5 minutes (queue drain + circuit close)

### Manual Recovery Steps
```bash
# 1. Check circuit breaker status
curl http://localhost:3000/health | jq '.circuitBreakers'

# 2. Check queue depth for stuck jobs
curl -H "X-API-Key: $ADMIN_KEY" http://localhost:3000/api/admin/queues

# 3. If queue is stuck, manually reset the circuit breaker
curl -X POST -H "X-API-Key: $ADMIN_KEY" \
  http://localhost:3000/api/admin/circuit-breakers/reset \
  -d '{"provider": "mtn"}'

# 4. Retry failed jobs manually
curl -X POST -H "X-API-Key: $ADMIN_KEY" \
  http://localhost:3000/api/admin/queues/retry-failed

# 5. Verify queue draining
watch -n 5 'curl -s http://localhost:3000/health | jq ".queues"'
```

### Chaos Test Run
```bash
k6 run -e SCENARIO=provider_outage \
       -e BASE_URL=http://localhost:3000 \
       tests/load/disaster-recovery/chaos-scenarios.js
```

---

## Failure Scenario 2 — Database Failure

### What is simulated
PostgreSQL primary becomes unreachable (connection pool exhausted, node failure, or failover in progress).

### Expected system behaviour
| Phase | Expected |
|-------|----------|
| Failure begins | New connections fail; existing pool connections used until exhausted |
| Read path | Redis cache serves stale reads; returns `200` with `X-Cache: stale` header |
| Write path | Circuit breaker opens; returns `503 Service Unavailable` with `Retry-After: 30` |
| DB reconnect | pg pool auto-reconnects with exponential backoff |
| Post-recovery | Reads switch back to DB; writes resume; no data duplicated |

### Recovery SLA
- Read availability (from cache): immediate
- Write resumption: < 5 minutes (DB failover + pool reconnect)

### Manual Recovery Steps
```bash
# 1. Check DB connectivity
psql $DATABASE_URL -c "SELECT 1;"

# 2. Check pg pool status
curl http://localhost:3000/ready | jq '.database'

# 3. If using read replica, verify replica lag
psql $DATABASE_REPLICA_URL -c "SELECT now() - pg_last_xact_replay_timestamp() AS replication_lag;"

# 4. Force pool reconnect (graceful restart)
curl -X POST -H "X-API-Key: $ADMIN_KEY" \
  http://localhost:3000/api/admin/db/reconnect

# 5. Verify DB health restored
curl http://localhost:3000/health | jq '.database'

# 6. Check for any transactions stuck in 'pending' state
psql $DATABASE_URL -c "
  SELECT id, status, created_at
  FROM transactions
  WHERE status = 'pending'
    AND created_at < NOW() - INTERVAL '10 minutes'
  ORDER BY created_at DESC
  LIMIT 20;
"
```

### Chaos Test Run
```bash
k6 run -e SCENARIO=db_failure \
       -e BASE_URL=http://localhost:3000 \
       tests/load/disaster-recovery/chaos-scenarios.js
```

---

## Failure Scenario 3 — Network Partition

### What is simulated
Random packet loss (30% of requests time out) simulating split-brain or flaky network between services.

### Expected system behaviour
| Phase | Expected |
|-------|----------|
| Partition active | ~30% of requests timeout; retries succeed via idempotency |
| Idempotency layer | Duplicate requests with same key return cached response |
| Queue broker | Redis/RabbitMQ reconnects automatically |
| Client behaviour | Exponential backoff retries with same idempotency key |
| Recovery | Full connectivity restored; no duplicate transactions |

### Recovery SLA
- Automatic retry resolution: < 2 minutes (client retry logic)
- Full system recovery: < 5 minutes

### Manual Recovery Steps
```bash
# 1. Check network connectivity between services
curl -v http://localhost:3000/health
curl -v http://localhost:6379/ping  # Redis

# 2. Check Redis connectivity
redis-cli ping

# 3. Check RabbitMQ (if used)
rabbitmqctl status | grep -E "Running|Listeners"

# 4. Review connection error logs
docker logs proxypay-api 2>&1 | grep -E "ECONNREFUSED|ETIMEDOUT" | tail -20

# 5. Check idempotency cache for stuck keys
redis-cli keys "idempotency:*" | wc -l

# 6. If Redis is partitioned, flush stuck idempotency cache
# WARNING: Only do this if you are certain no real duplicates exist
redis-cli --scan --pattern "idempotency:*" | xargs redis-cli del
```

### Chaos Test Run
```bash
k6 run -e SCENARIO=network_partition \
       -e BASE_URL=http://localhost:3000 \
       tests/load/disaster-recovery/chaos-scenarios.js
```

---

## Full DR Test (All Scenarios)

Runs all three failure types concurrently across VUs to simulate a realistic compounded failure event.

```bash
k6 run -e SCENARIO=full_dr \
       -e BASE_URL=http://localhost:3000 \
       tests/load/disaster-recovery/chaos-scenarios.js
```

## Recovery Validation (Post-Incident)

After resolving an incident, run this to confirm full system recovery:

```bash
k6 run -e SCENARIO=recovery_validation \
       -e BASE_URL=http://localhost:3000 \
       tests/load/disaster-recovery/chaos-scenarios.js
```

---

## Acceptance Criteria

| Criterion | Target | How Measured |
|-----------|--------|--------------|
| Graceful degradation | API returns 202/503, never 500 | `chaos_error_rate` threshold |
| Recovery time | < 5 minutes | `recovery_time_ms` max < 300,000ms |
| No data loss | 0 duplicate/lost transactions | `data_loss_events` count = 0 |
| Idempotent retries | 100% of retries succeed on recovery | `retry_success_total` counter |

---

## Toxiproxy Integration (Advanced)

For true network-level chaos injection (recommended for staging), use [Toxiproxy](https://github.com/Shopify/toxiproxy):

```bash
# Start Toxiproxy
toxiproxy-server &

# Create proxy for PostgreSQL
toxiproxy-cli create --listen localhost:5433 --upstream localhost:5432 postgres

# Simulate latency
toxiproxy-cli toxic add postgres --type latency --attribute latency=3000

# Simulate connection drop
toxiproxy-cli toxic add postgres --type reset_peer

# Run DR test through proxy
k6 run -e SCENARIO=db_failure \
       -e BASE_URL=http://localhost:3000 \
       -e DATABASE_URL=postgresql://user:pass@localhost:5433/db \
       tests/load/disaster-recovery/chaos-scenarios.js

# Remove toxics to simulate recovery
toxiproxy-cli toxic remove postgres --toxicName latency_downstream
```

---

## CI Integration

The `flaky-test-detection.yml` workflow can be extended to run DR validation after deployments:

```yaml
- name: Run DR smoke test
  run: |
    k6 run -e SCENARIO=recovery_validation \
           -e BASE_URL=${{ env.STAGING_URL }} \
           tests/load/disaster-recovery/chaos-scenarios.js
```

---

## Results

Test results are written to `tests/load/disaster-recovery/results/dr-summary.json` after each run.

Key fields:
- `acceptance.gracefulRecovery` — system degraded without cascading failures
- `acceptance.recoveryUnder5Min` — system recovered within SLA
- `acceptance.noDataLoss` — all transactions accounted for via idempotency
