/**
 * Cache Metrics Collector
 *
 * Tracks hit/miss rates, evictions, latency, and key-level miss counts for
 * all cache operations. Exposes Prometheus counters/gauges that slot into the
 * existing metrics infrastructure (src/utils/metrics.ts).
 *
 * Usage:
 *   import { cacheMetricsCollector } from "./cacheMetrics";
 *
 *   cacheMetricsCollector.recordHit("exchange-rate:XAF_USDC", 0.3);
 *   cacheMetricsCollector.recordMiss("exchange-rate:XAF_USDC", 85);
 *   const m = cacheMetricsCollector.getMetrics();
 */

import { Counter, Gauge, Histogram } from "prom-client";
import { register } from "../utils/metrics";

// ─────────────────────────────────────────────────────────────────────────────
// Prometheus instruments (keyed by cache namespace extracted from key prefix)
// ─────────────────────────────────────────────────────────────────────────────

const cacheOpsHitsTotal = new Counter({
  name: "cache_ops_hits_total",
  help: "Total cache hit operations tracked by CacheMetricsCollector",
  labelNames: ["namespace"],
  registers: [register],
});

const cacheOpsMissesTotal = new Counter({
  name: "cache_ops_misses_total",
  help: "Total cache miss operations tracked by CacheMetricsCollector",
  labelNames: ["namespace"],
  registers: [register],
});

const cacheOpsEvictionsTotal = new Counter({
  name: "cache_ops_evictions_total",
  help: "Total cache eviction events tracked by CacheMetricsCollector",
  labelNames: ["namespace"],
  registers: [register],
});

const cacheOpsTotalKeysGauge = new Gauge({
  name: "cache_ops_total_keys",
  help: "Current total number of distinct cache keys observed by CacheMetricsCollector",
  registers: [register],
});

const cacheOpsHitRatioGauge = new Gauge({
  name: "cache_ops_hit_ratio",
  help: "Rolling cache hit ratio (hits / (hits + misses)) across all namespaces",
  registers: [register],
});

const cacheOpsLatencyMs = new Histogram({
  name: "cache_ops_latency_ms",
  help: "Latency (ms) of cache lookup operations, split by hit/miss",
  labelNames: ["result"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250],
  registers: [register],
});

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface CacheMetrics {
  /** Total hits since last reset */
  hits: number;
  /** Total misses since last reset */
  misses: number;
  /** hits / (hits + misses), or 0 when no ops recorded */
  hitRate: number;
  /** Number of distinct keys tracked */
  totalKeys: number;
  /** Approximate memory used by this collector (not Redis) in bytes */
  memoryUsedBytes: number;
  /** Average lookup latency in milliseconds */
  avgLatencyMs: number;
  /** Total evictions recorded */
  evictions: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal state types
// ─────────────────────────────────────────────────────────────────────────────

interface KeyStats {
  misses: number;
  hits: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a short namespace prefix from a cache key for Prometheus labels.
 * e.g. "exchange-rate:XAF_USDC" → "exchange-rate"
 *      "cache:general-stats"    → "cache"
 */
function namespaceFromKey(key: string): string {
  const colonIdx = key.indexOf(":");
  return colonIdx === -1 ? key : key.slice(0, colonIdx);
}

// ─────────────────────────────────────────────────────────────────────────────
// CacheMetricsCollector
// ─────────────────────────────────────────────────────────────────────────────

export class CacheMetricsCollector {
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private totalLatencyMs = 0;
  private totalOps = 0;

  /** Per-key miss/hit tracking for top-missed-keys reporting */
  private keyStats = new Map<string, KeyStats>();

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Record a cache hit for `key` with the given lookup `latencyMs`.
   */
  recordHit(key: string, latencyMs: number): void {
    this.hits++;
    this.totalLatencyMs += latencyMs;
    this.totalOps++;

    const ns = namespaceFromKey(key);
    cacheOpsHitsTotal.inc({ namespace: ns });
    cacheOpsLatencyMs.observe({ result: "hit" }, latencyMs);

    this._ensureKeyStats(key).hits++;
    this._updateDerivedGauges();
  }

  /**
   * Record a cache miss for `key` with the given lookup `latencyMs`.
   */
  recordMiss(key: string, latencyMs: number): void {
    this.misses++;
    this.totalLatencyMs += latencyMs;
    this.totalOps++;

    const ns = namespaceFromKey(key);
    cacheOpsMissesTotal.inc({ namespace: ns });
    cacheOpsLatencyMs.observe({ result: "miss" }, latencyMs);

    this._ensureKeyStats(key).misses++;
    this._updateDerivedGauges();
  }

  /**
   * Record an eviction event for `key`.
   */
  recordEviction(key: string): void {
    this.evictions++;

    const ns = namespaceFromKey(key);
    cacheOpsEvictionsTotal.inc({ namespace: ns });
  }

  /**
   * Return a snapshot of current aggregate metrics.
   */
  getMetrics(): CacheMetrics {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      totalKeys: this.keyStats.size,
      // Rough in-process memory estimate: ~80 bytes per Map entry
      memoryUsedBytes: this.keyStats.size * 80,
      avgLatencyMs: this.totalOps === 0 ? 0 : this.totalLatencyMs / this.totalOps,
      evictions: this.evictions,
    };
  }

  /**
   * Return the `limit` keys with the highest miss counts.
   */
  getTopMissedKeys(limit = 10): Array<{ key: string; misses: number }> {
    const entries = Array.from(this.keyStats.entries())
      .map(([key, stats]) => ({ key, misses: stats.misses }))
      .filter((e) => e.misses > 0)
      .sort((a, b) => b.misses - a.misses);

    return entries.slice(0, limit);
  }

  /**
   * Reset all in-process counters.
   * Note: Prometheus counters are monotonic and cannot be reset — only
   * in-memory state used by `getMetrics()` is cleared.
   */
  reset(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.totalLatencyMs = 0;
    this.totalOps = 0;
    this.keyStats.clear();
    cacheOpsTotalKeysGauge.set(0);
    cacheOpsHitRatioGauge.set(0);
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private _ensureKeyStats(key: string): KeyStats {
    let s = this.keyStats.get(key);
    if (!s) {
      s = { misses: 0, hits: 0 };
      this.keyStats.set(key, s);
    }
    return s;
  }

  private _updateDerivedGauges(): void {
    cacheOpsTotalKeysGauge.set(this.keyStats.size);
    const total = this.hits + this.misses;
    cacheOpsHitRatioGauge.set(total === 0 ? 0 : this.hits / total);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton — share one collector across the process
// ─────────────────────────────────────────────────────────────────────────────

export const cacheMetricsCollector = new CacheMetricsCollector();
