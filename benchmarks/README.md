# Soroban Gas Benchmark

This benchmark measures Soroban gas usage for the Escrow contract methods.

## Purpose

- Build the `contracts/escrow` Soroban contract.
- Deploy it locally through the Soroban CLI.
- Invoke common contract methods.
- Parse and report gas usage for each method.

## Usage

1. Build the Escrow contract:

```bash
npm run contracts:build
```

2. Run the benchmark:

```bash
npm run bench:soroban-gas
```

3. Optional environment variables:

- `SOROBAN_NETWORK` - Soroban network name, default is `local`.
- `SOROBAN_RPC_URL` - RPC URL to use instead of a named network.
- `SOROBAN_SECRET_KEY` - Secret key used to invoke contract methods.
- `SKIP_BUILD=1` - Skip WASM build if the contract is already compiled.

## Notes

- The script requires the Soroban CLI installed and available in `PATH`.
- If the CLI is unavailable, the script will still emit the current WASM size and instructions.
- `soroban` output must include gas metrics for the script to parse them correctly.

# Database Pool & Job Queue Load Tests

These load tests model realistic mixed traffic across the database connection pool,
provider throttle behavior, and the job queue, then assert latency, error-rate, and
queue-backlog budgets so the run fails when capacity is exceeded.

## Tooling baseline

- [k6](https://k6.io/) for the mixed-traffic scenario (HTTP + queue enqueue).
- [autocannon](https://github.com/mcollina/autocannon) for quick single-endpoint saturation checks.
- PostgreSQL (pool under test) and Redis (job queue backend).
- A provider mock server that simulates upstream throttling (429s + `Retry-After`).

## Scenario

A single k6 scenario mixes three traffic classes in the same run:

1. **Database pool** - read/write API calls that hold pool connections long enough to
   exercise pool contention (e.g. `GET /api/transactions`, `POST /api/transactions`).
2. **Provider throttle** - calls routed through the provider mock, which returns 429s
   under load so the client's backoff/retry path is exercised.
3. **Job queue** - enqueue operations that push work onto Redis; the scenario also
   samples queue depth to detect backlog growth.

## Thresholds

Budgets are enforced as k6 thresholds so the test exits non-zero when exceeded:

- `http_req_duration`: p95 < 500 ms, p99 < 1000 ms.
- `http_req_failed`: rate < 1%.
- `queue_backlog`: p95 < 1000 pending jobs (custom metric sampled from Redis).
- `provider_throttled`: rate < 5% (expected throttle responses, not errors).

## Tested budgets

Record the environment the budgets were validated against. Update this table when
instance or database sizing changes.

| Component | Budget |
| --- | --- |
| App instance | 2 vCPU / 4 GB RAM, 2 replicas |
| DB pool size | 20 connections per instance (40 total) |
| PostgreSQL | `max_connections = 100`, 4 vCPU / 16 GB |
| Redis | 1 GB, `maxmemory-policy allkeys-lru` |
| Provider mock | 50 req/s sustained, 429 above limit |

## Running

```bash
# Start dependencies (PostgreSQL, Redis, provider mock)
docker compose -f benchmarks/load/docker-compose.yml up -d

# Mixed-traffic scenario
k6 run benchmarks/load/mixed-traffic.js

# Quick saturation check against a single endpoint
npx autocannon -c 50 -d 30 http://localhost:3000/api/transactions
```

## Notes

- Thresholds are intentionally conservative; tighten them only after recording a
  new tested-budget baseline above.
- The provider mock must be running for throttle assertions to be meaningful.
