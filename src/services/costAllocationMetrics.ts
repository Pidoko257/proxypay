/**
 * Cost Allocation Metrics Service — issue #261
 *
 * Tracks resource usage (API calls, DB queries, storage operations) broken
 * down by provider (MTN, Airtel, Orange) and feature (deposit, withdraw, KYC,
 * webhook, …) to calculate unit economics per transaction.
 *
 * Design:
 *  - Prometheus counters / histograms with `provider` + `feature` labels
 *    → zero runtime overhead (O(1) label lookup in prom-client)
 *  - Separate cost analytics helpers aggregate the raw Prometheus data into
 *    human-readable unit-economics objects that can be exported to dashboards
 *    or a data warehouse via the /metrics route.
 *
 * Usage:
 *   import { costMetrics } from "./costAllocationMetrics";
 *
 *   // Track a provider API call
 *   costMetrics.recordApiCall("mtn", "deposit", durationMs, "success");
 *
 *   // Track a DB query
 *   costMetrics.recordDbQuery("airtel", "withdraw", durationMs);
 *
 *   // Track storage usage (S3, etc.)
 *   costMetrics.recordStorageOp("orange", "kyc", bytesWritten);
 */

import { Counter, Histogram, Gauge, Registry } from "prom-client";
import { register as globalRegistry } from "../utils/metrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Provider = "mtn" | "airtel" | "orange" | "stellar" | "internal";
export type Feature =
  | "deposit"
  | "withdraw"
  | "kyc"
  | "webhook"
  | "aml"
  | "reconciliation"
  | "statement"
  | "fee_calculation"
  | "exchange_rate"
  | "other";

export interface UnitCostRecord {
  provider: Provider | string;
  feature: Feature | string;
  api_calls: number;
  db_queries: number;
  storage_bytes: number;
  total_transactions: number;
  /**
   * Estimated API cost in USD-cents per transaction.
   * Derived from api_calls * COST_PER_API_CALL / total_transactions.
   */
  estimated_api_cost_usd_cents_per_tx: number;
  /**
   * Estimated DB cost in USD-cents per transaction.
   * Derived from db_queries * COST_PER_DB_QUERY / total_transactions.
   */
  estimated_db_cost_usd_cents_per_tx: number;
  /** Sum of the two above for total cost. */
  estimated_total_cost_usd_cents_per_tx: number;
}

// ---------------------------------------------------------------------------
// Cost constants (tuneable via env vars)
// These are conservative baselines — operators should override with their
// actual AWS / GCP / provider pricing.
// ---------------------------------------------------------------------------

const COST_PER_API_CALL_USD_CENTS = parseFloat(
  process.env.COST_PER_API_CALL_USD_CENTS ?? "0.001",
);
const COST_PER_DB_QUERY_USD_CENTS = parseFloat(
  process.env.COST_PER_DB_QUERY_USD_CENTS ?? "0.0005",
);
const COST_PER_STORAGE_KB_USD_CENTS = parseFloat(
  process.env.COST_PER_STORAGE_KB_USD_CENTS ?? "0.00002",
);

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

/**
 * Total provider API calls broken down by provider, feature, and outcome.
 * Enables: cost per provider, most expensive feature, error rates.
 */
export const costApiCallsTotal = new Counter({
  name: "cost_provider_api_calls_total",
  help: "Total provider API calls tracked for cost allocation",
  labelNames: ["provider", "feature", "status"] as const,
  registers: [globalRegistry],
});

/**
 * Duration histogram for provider API calls — p95/p99 latency per provider
 * helps identify slow (and therefore expensive) integrations.
 */
export const costApiCallDurationMs = new Histogram({
  name: "cost_provider_api_call_duration_ms",
  help: "Duration of provider API calls in milliseconds (cost allocation)",
  labelNames: ["provider", "feature"] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [globalRegistry],
});

/**
 * Database queries attributed to a provider + feature.
 * Tracks read vs write separately for replica routing cost analysis.
 */
export const costDbQueriesTotal = new Counter({
  name: "cost_db_queries_total",
  help: "Total database queries tracked for cost allocation",
  labelNames: ["provider", "feature", "query_type"] as const,
  registers: [globalRegistry],
});

/**
 * Duration histogram for DB queries — identifies expensive DB operations per
 * feature so the team can decide where to add caching or indexes.
 */
export const costDbQueryDurationMs = new Histogram({
  name: "cost_db_query_duration_ms",
  help: "Duration of database queries in milliseconds (cost allocation)",
  labelNames: ["provider", "feature", "query_type"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [globalRegistry],
});

/**
 * Storage bytes written (S3 uploads, document storage, etc.)
 * Labelled by provider + feature so KYC document costs are visible.
 */
export const costStorageBytesTotal = new Counter({
  name: "cost_storage_bytes_total",
  help: "Total bytes written to storage for cost allocation",
  labelNames: ["provider", "feature"] as const,
  registers: [globalRegistry],
});

/**
 * Completed transactions per provider + feature.
 * Dividing cost counters by this gives unit cost per transaction.
 */
export const costTransactionsTotal = new Counter({
  name: "cost_transactions_total",
  help: "Total completed transactions for unit cost calculation",
  labelNames: ["provider", "feature", "status"] as const,
  registers: [globalRegistry],
});

/**
 * Estimated cost per transaction gauge (updated on each transaction).
 * Exported directly so Grafana can display it without PromQL division.
 */
export const costEstimatedCentsPerTx = new Gauge({
  name: "cost_estimated_cents_per_transaction",
  help: "Estimated cost in USD-cents per transaction by provider and feature",
  labelNames: ["provider", "feature"] as const,
  registers: [globalRegistry],
});

// ---------------------------------------------------------------------------
// In-memory accumulator for unit cost calculation
// (Prometheus counters are write-only so we track the values separately for
//  the analytics helper.  This is reset on restart — long-term data lives in
//  the time-series DB that scrapes the /metrics endpoint.)
// ---------------------------------------------------------------------------

interface AccumulatorEntry {
  api_calls: number;
  db_queries: number;
  storage_bytes: number;
  transactions: number;
}

const accumulator = new Map<string, AccumulatorEntry>();

function accKey(provider: string, feature: string): string {
  return `${provider}::${feature}`;
}

function getOrCreate(provider: string, feature: string): AccumulatorEntry {
  const key = accKey(provider, feature);
  if (!accumulator.has(key)) {
    accumulator.set(key, {
      api_calls: 0,
      db_queries: 0,
      storage_bytes: 0,
      transactions: 0,
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return accumulator.get(key)!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const costMetrics = {
  /**
   * Record a provider API call.
   * Call this from provider service wrappers (MobileMoneyService, etc.).
   */
  recordApiCall(
    provider: Provider | string,
    feature: Feature | string,
    durationMs: number,
    status: "success" | "error" | "timeout" = "success",
  ): void {
    costApiCallsTotal.inc({ provider, feature, status });
    costApiCallDurationMs.observe({ provider, feature }, durationMs);
    getOrCreate(provider, feature).api_calls += 1;
  },

  /**
   * Record a database query attributed to a provider + feature.
   * Call this from query helpers when a provider can be inferred from context.
   */
  recordDbQuery(
    provider: Provider | string,
    feature: Feature | string,
    durationMs: number,
    queryType: "read" | "write" = "read",
  ): void {
    costDbQueriesTotal.inc({ provider, feature, query_type: queryType });
    costDbQueryDurationMs.observe(
      { provider, feature, query_type: queryType },
      durationMs,
    );
    getOrCreate(provider, feature).db_queries += 1;
  },

  /**
   * Record bytes written to storage (S3, local disk, etc.).
   */
  recordStorageOp(
    provider: Provider | string,
    feature: Feature | string,
    bytes: number,
  ): void {
    costStorageBytesTotal.inc({ provider, feature }, bytes);
    getOrCreate(provider, feature).storage_bytes += bytes;
  },

  /**
   * Record a completed transaction and update the cost-per-transaction gauge.
   * Call this from the transaction completion path.
   */
  recordTransaction(
    provider: Provider | string,
    feature: Feature | string,
    status: "completed" | "failed" | "refunded" = "completed",
  ): void {
    costTransactionsTotal.inc({ provider, feature, status });

    const entry = getOrCreate(provider, feature);
    entry.transactions += 1;

    // Refresh the estimated cost gauge
    const apiCost = entry.api_calls * COST_PER_API_CALL_USD_CENTS;
    const dbCost = entry.db_queries * COST_PER_DB_QUERY_USD_CENTS;
    const storageCost =
      (entry.storage_bytes / 1024) * COST_PER_STORAGE_KB_USD_CENTS;
    const totalCost = apiCost + dbCost + storageCost;
    const perTx = entry.transactions > 0 ? totalCost / entry.transactions : 0;

    costEstimatedCentsPerTx.set({ provider, feature }, perTx);
  },

  /**
   * Return unit cost analytics for all tracked provider + feature combinations.
   * Suitable for export to a data warehouse or analytics dashboard.
   */
  getUnitCostAnalytics(): UnitCostRecord[] {
    const results: UnitCostRecord[] = [];

    for (const [key, entry] of accumulator.entries()) {
      const [provider, feature] = key.split("::");

      const apiCost = entry.api_calls * COST_PER_API_CALL_USD_CENTS;
      const dbCost = entry.db_queries * COST_PER_DB_QUERY_USD_CENTS;
      const storageCost =
        (entry.storage_bytes / 1024) * COST_PER_STORAGE_KB_USD_CENTS;
      const totalCost = apiCost + dbCost + storageCost;
      const perTx =
        entry.transactions > 0 ? totalCost / entry.transactions : 0;
      const apiPerTx =
        entry.transactions > 0 ? apiCost / entry.transactions : 0;
      const dbPerTx =
        entry.transactions > 0 ? dbCost / entry.transactions : 0;

      results.push({
        provider: provider ?? "unknown",
        feature: feature ?? "unknown",
        api_calls: entry.api_calls,
        db_queries: entry.db_queries,
        storage_bytes: entry.storage_bytes,
        total_transactions: entry.transactions,
        estimated_api_cost_usd_cents_per_tx: Math.round(apiPerTx * 10000) / 10000,
        estimated_db_cost_usd_cents_per_tx: Math.round(dbPerTx * 10000) / 10000,
        estimated_total_cost_usd_cents_per_tx: Math.round(perTx * 10000) / 10000,
      });
    }

    // Sort by total cost descending so the most expensive shows first
    results.sort(
      (a, b) =>
        b.estimated_total_cost_usd_cents_per_tx -
        a.estimated_total_cost_usd_cents_per_tx,
    );

    return results;
  },

  /** Reset in-memory accumulator (for testing). */
  _reset(): void {
    accumulator.clear();
  },
} as const;
