# Benchmark & Load Test Results

This document records the tested instance and database budgets for the
load-testing suite. Update the tables below whenever the reference
environment or capacity budgets change.

## Reference environment

| Component | Tested budget |
| --- | --- |
| Application instance | 2 vCPU / 4 GiB RAM (single replica) |
| PostgreSQL | 2 vCPU / 4 GiB RAM, `max_connections = 100` |
| Application DB pool | `pool.max = 20` connections per instance |
| Redis | 1 vCPU / 1 GiB RAM, `maxmemory-policy = noeviction` |
| Provider mock server | 1 vCPU / 512 MiB RAM, fixed latency 50 ms |

## Mixed-traffic load scenario

The load test (`benchmarks/load/mixed-traffic.js`, run with k6) models
realistic mixed traffic in a single scenario:

- **Database pool pressure** — concurrent API reads/writes that exercise the
  connection pool (`pool.max = 20`).
- **Provider throttle behavior** — calls routed through the provider mock
  server, which enforces the configured rate limit and returns `429` when
  exceeded.
- **Job queue load** — enqueue/dequeue traffic against Redis-backed queues,
  including backlog growth under sustained producer pressure.

## Thresholds

The scenario fails when any budget below is exceeded:

| Metric | Threshold |
| --- | --- |
| `http_req_duration` p95 | < 500 ms |
| `http_req_duration` p99 | < 1000 ms |
| `http_req_failed` (error rate) | < 1% |
| `queue_backlog` (max pending jobs) | < 1000 |
| `provider_throttled` (429 rate) | < 5% |

## Recorded results

| Date | Instance | DB pool | p95 | p99 | Error rate | Max backlog | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| _pending_ | 2 vCPU / 4 GiB | 20 | — | — | — | — | — |

> Fill in the recorded results after running the load test against the
> reference environment above. Keep the tested instance and database budgets
> in sync with the actual infrastructure used for the run.
