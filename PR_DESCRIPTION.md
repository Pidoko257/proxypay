# Stellar Network Fee Estimation Caching

## Problem

Every payment initiation currently fetches the current fee from Stellar Horizon synchronously via `server.fetchBaseFee()`, adding latency to each transaction. This is particularly impactful for high-throughput payment processing where every millisecond counts.

## Solution

Implement a Redis-backed caching layer for Stellar Horizon fee statistics with a 30-second TTL, refreshed by a background cron job. The payment service reads from the cache instead of making a Horizon call per payment, eliminating redundant network round-trips.

## Changes

### New Files

| File | Purpose |
|------|---------|
| `src/services/stellarFeeStatsCache.ts` | Cache service: reads fee stats from Redis (with Horizon fallback on cache miss), fetches fresh stats from Horizon, writes to Redis with 30s TTL |
| `src/jobs/stellarFeeStatsJob.ts` | Background cron job that refreshes the fee stats cache every 30 seconds |

### Modified Files

| File | Change |
|------|--------|
| `src/stellar/transactions.ts` | `getTransactionBaseFee()` now reads from Redis cache first; falls back to `server.fetchBaseFee()` on cache miss |
| `src/jobs/scheduler.ts` | Registered the new `stellar-fee-stats` job at `*/30 * * * * *` |
| `src/index.ts` | Added fee stats cache warm-up on startup (after Redis connects) |

## How It Works

1. **Startup**: On application start, after Redis connects, the fee stats cache is immediately populated by fetching from Horizon and storing in Redis.
2. **Background refresh**: A cron job runs every 30 seconds, fetches `server.feeStats()` from Horizon, and writes `last_ledger_base_fee` to Redis under key `stellar:fee_stats` with a 30-second TTL.
3. **Payment flow**: When building a transaction, `getTransactionBaseFee()` attempts to read from Redis first. If the key exists, it returns the cached value immediately (no network call). On cache miss, it falls back to the original `server.fetchBaseFee()`.
4. **Logging**: Cache values are logged at startup and on each background refresh for observability.

## Acceptance Criteria

- [x] Background job fetches Horizon fee stats every 30 seconds and stores in Redis
- [x] Payment service reads fee from Redis cache instead of calling Horizon per request
- [x] On cache miss, fee is fetched directly from Horizon as a fallback
- [x] Cached fee values are logged at startup and on each refresh

closes #113
