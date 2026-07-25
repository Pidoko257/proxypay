/**
 * ExchangeRateCache
 *
 * Dedicated cache for exchange rates using the LayeredCache SWR strategy.
 * Exchange rates are time-sensitive:
 *   - Fresh for 5 minutes (no background refresh triggered)
 *   - Stale-while-revalidate window of 10 extra minutes (serve stale, refresh in background)
 *   - Fully evicted after 15 total minutes
 *
 * Key format: `exchange-rate:<FROM>_<TO>`  (e.g. "exchange-rate:XAF_USDC")
 *
 * All gets/sets are instrumented via CacheMetricsCollector.
 */

import { layeredCache } from "./layeredCache";
import { cacheMetricsCollector } from "./cacheMetrics";
import logger from "../utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// TTL constants (seconds)
// ─────────────────────────────────────────────────────────────────────────────

export const EXCHANGE_RATE_TTL = {
  /** How long a rate is considered fresh (no background fetch triggered) */
  freshSeconds: 300, // 5 minutes
  /** Additional stale window — serve stale data while refreshing in background */
  staleSeconds: 600, // 10 minutes (total lifetime = 900s = 15 min)
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ExchangeRate {
  /** Source currency code, e.g. "XAF" */
  from: string;
  /** Destination currency code, e.g. "USDC" */
  to: string;
  /** Mid-market rate */
  rate: number;
  /** ISO 8601 timestamp when the rate was fetched from the upstream source */
  fetchedAt: string;
  /** Optional provider that sourced the rate */
  provider?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Key helper
// ─────────────────────────────────────────────────────────────────────────────

const KEY_PREFIX = "exchange-rate";

function rateKey(from: string, to: string): string {
  return `${KEY_PREFIX}:${from.toUpperCase()}_${to.toUpperCase()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ExchangeRateCache
// ─────────────────────────────────────────────────────────────────────────────

export class ExchangeRateCache {
  /** In-memory registry of keys that have been set, for stats reporting */
  private readonly knownKeys = new Set<string>();

  // ── Get ───────────────────────────────────────────────────────────────────

  /**
   * Retrieve a cached exchange rate.
   * Returns `null` on cache miss (caller must fetch from upstream).
   *
   * NOTE: This performs a plain get (no SWR revalidation).  Use
   * `getOrFetch` when you want automatic SWR background refresh.
   */
  async getRate(fromCurrency: string, toCurrency: string): Promise<ExchangeRate | null> {
    const key = rateKey(fromCurrency, toCurrency);
    const start = Date.now();

    try {
      // LayeredCache wraps SWR values in { data, freshUntil } — we stored
      // ExchangeRate directly via `setRate`, so use a plain get here.
      const value = await layeredCache.get<ExchangeRate>(key);
      const latencyMs = Date.now() - start;

      if (value !== null) {
        cacheMetricsCollector.recordHit(key, latencyMs);
        logger.debug({ key }, "[ExchangeRateCache] Hit");
        return value;
      }

      cacheMetricsCollector.recordMiss(key, latencyMs);
      logger.debug({ key }, "[ExchangeRateCache] Miss");
      return null;
    } catch (err) {
      const latencyMs = Date.now() - start;
      cacheMetricsCollector.recordMiss(key, latencyMs);
      logger.warn({ key, err }, "[ExchangeRateCache] Error on getRate");
      return null;
    }
  }

  /**
   * SWR-based get-or-fetch.  If the cached value is stale the fetcher is
   * called in the background while stale data is returned immediately.
   */
  async getOrFetch(
    fromCurrency: string,
    toCurrency: string,
    fetcher: () => Promise<ExchangeRate>,
  ): Promise<ExchangeRate> {
    const key = rateKey(fromCurrency, toCurrency);
    const start = Date.now();

    // We wrap ExchangeRate in the SWR envelope via getSwr
    try {
      const result = await layeredCache.getSwr<ExchangeRate>(
        key,
        fetcher,
        {
          freshTtlSec: EXCHANGE_RATE_TTL.freshSeconds,
          staleTtlSec: EXCHANGE_RATE_TTL.staleSeconds,
        },
      );

      const latencyMs = Date.now() - start;
      this.knownKeys.add(key);

      // We can't easily distinguish hit vs miss post-SWR, so record based on
      // whether the key was already known before this call.
      if (this.knownKeys.has(key)) {
        cacheMetricsCollector.recordHit(key, latencyMs);
      } else {
        cacheMetricsCollector.recordMiss(key, latencyMs);
      }

      return result;
    } catch (err) {
      const latencyMs = Date.now() - start;
      cacheMetricsCollector.recordMiss(key, latencyMs);
      logger.warn({ key, err }, "[ExchangeRateCache] getOrFetch error");
      throw err;
    }
  }

  // ── Set ───────────────────────────────────────────────────────────────────

  /**
   * Store an exchange rate in the layered cache with the standard SWR TTL.
   * The value is stored directly (not wrapped in a SWR envelope), so that
   * `getRate` can retrieve it without needing a fetcher.
   *
   * Use `setRate` when you have a freshly fetched rate and want to populate
   * the cache without going through the SWR path (e.g. cache warming).
   */
  async setRate(
    fromCurrency: string,
    toCurrency: string,
    rate: ExchangeRate,
  ): Promise<void> {
    const key = rateKey(fromCurrency, toCurrency);
    const totalTtlSec = EXCHANGE_RATE_TTL.freshSeconds + EXCHANGE_RATE_TTL.staleSeconds;

    try {
      await layeredCache.set(key, rate, totalTtlSec);
      this.knownKeys.add(key);
      logger.debug({ key, rate }, "[ExchangeRateCache] Rate set");
    } catch (err) {
      logger.warn({ key, err }, "[ExchangeRateCache] Error on setRate");
    }
  }

  // ── Warm ─────────────────────────────────────────────────────────────────

  /**
   * Pre-populate the cache for a list of currency pairs.
   * Each pair is fetched via `fetcher`; errors per-pair are logged but do not
   * abort the rest of the warming run.
   *
   * @param pairs  Currency pairs to warm
   * @param fetcher  Function that fetches a live rate for a given pair
   */
  async warmRates(
    pairs: Array<{ from: string; to: string }>,
    fetcher: (from: string, to: string) => Promise<ExchangeRate>,
  ): Promise<void> {
    await Promise.allSettled(
      pairs.map(async ({ from, to }) => {
        try {
          const rate = await fetcher(from, to);
          await this.setRate(from, to, rate);
          logger.info({ from, to }, "[ExchangeRateCache] Warmed rate");
        } catch (err) {
          logger.warn({ from, to, err }, "[ExchangeRateCache] Failed to warm rate");
        }
      }),
    );
  }

  // ── Invalidate ────────────────────────────────────────────────────────────

  /**
   * Invalidate the cache entry for a specific currency pair.
   */
  async invalidateRate(fromCurrency: string, toCurrency: string): Promise<void> {
    const key = rateKey(fromCurrency, toCurrency);
    try {
      await layeredCache.del(key);
      this.knownKeys.delete(key);
      cacheMetricsCollector.recordEviction(key);
      logger.info({ key }, "[ExchangeRateCache] Rate invalidated");
    } catch (err) {
      logger.warn({ key, err }, "[ExchangeRateCache] Error on invalidateRate");
    }
  }

  /**
   * Invalidate all exchange rate cache entries.
   */
  async invalidateAll(): Promise<void> {
    const pattern = `${KEY_PREFIX}:*`;
    try {
      await layeredCache.delPattern(pattern);

      for (const key of this.knownKeys) {
        cacheMetricsCollector.recordEviction(key);
      }
      this.knownKeys.clear();
      logger.info({ pattern }, "[ExchangeRateCache] All rates invalidated");
    } catch (err) {
      logger.warn({ pattern, err }, "[ExchangeRateCache] Error on invalidateAll");
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  /**
   * Return the number of exchange-rate keys currently tracked in this instance.
   * Note: this reflects only keys set/warmed via this instance; it does not
   * query Redis for keys set by other processes.
   */
  getCacheStats(): { totalCached: number; keys: string[] } {
    const keys = Array.from(this.knownKeys);
    return { totalCached: keys.length, keys };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

export const exchangeRateCache = new ExchangeRateCache();
