/**
 * Cache Warming Service
 * Issue: #171 – Redis Caching Layer
 *
 * Pre-populates critical caches on startup and on a configurable schedule so
 * that the first real request always hits L1/L2 instead of the database.
 *
 * Warming targets (in priority order):
 *  1. Exchange rates — volatile, 5-minute TTL
 *  2. General statistics — expensive aggregation, 10-minute TTL
 *  3. Active user profiles — top-N users by recent activity, 15-minute TTL
 *
 * Usage:
 *   import { cacheWarmingService } from "./cacheWarmingService";
 *
 *   // On app startup
 *   await cacheWarmingService.warmAll();
 *
 *   // Start re-warming every 4 minutes to keep exchange rates fresh
 *   cacheWarmingService.startScheduledWarming(4 * 60 * 1000);
 */

import { layeredCache } from "./layeredCache";
import { exchangeRateCache } from "./exchangeRateCache";
import { getCachedGeneralStats, getCachedVolumeByProvider } from "./cachedStatsService";
import { pool } from "../config/database";
import logger from "../utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WarmingResult {
  success: string[];
  failed: Array<{ name: string; error: string }>;
  durationMs: number;
}

interface WarmingTask {
  name: string;
  fn: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Common currency pairs to warm
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CURRENCY_PAIRS = [
  { from: "XAF", to: "USDC" },
  { from: "XAF", to: "XLM" },
  { from: "KES", to: "USDC" },
  { from: "KES", to: "XLM" },
  { from: "GHS", to: "USDC" },
  { from: "NGN", to: "USDC" },
  { from: "ZAR", to: "USDC" },
];

// ─────────────────────────────────────────────────────────────────────────────
// CacheWarmingService
// ─────────────────────────────────────────────────────────────────────────────

export class CacheWarmingService {
  private warmingTimer: ReturnType<typeof setInterval> | null = null;
  private isWarming = false;

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Warm exchange rates by fetching from the exchange_rate_buffers table
   * (the same source used by exchangeRateBufferService).
   */
  async warmExchangeRates(): Promise<void> {
    const { rows } = await pool.query<{
      from_currency: string;
      to_currency: string;
      rate: string;
      provider: string;
      updated_at: Date;
    }>(
      `SELECT from_currency, to_currency, rate, provider, updated_at
       FROM exchange_rate_buffers
       ORDER BY updated_at DESC`,
    );

    if (rows.length === 0) {
      logger.warn("[CacheWarming] No exchange rates found in DB to warm");
      return;
    }

    await Promise.allSettled(
      rows.map(async (r) => {
        await exchangeRateCache.setRate(r.from_currency, r.to_currency, {
          from: r.from_currency,
          to: r.to_currency,
          rate: parseFloat(r.rate),
          fetchedAt: r.updated_at.toISOString(),
          provider: r.provider,
        });
      }),
    );

    logger.info(
      { count: rows.length },
      "[CacheWarming] Exchange rates warmed",
    );
  }

  /**
   * Warm general statistics (total transactions, volumes by provider).
   */
  async warmGeneralStats(): Promise<void> {
    await Promise.all([
      getCachedGeneralStats(),
      getCachedVolumeByProvider(),
    ]);

    logger.info("[CacheWarming] General stats warmed");
  }

  /**
   * Warm user profiles for the most active users in the last 7 days.
   * Stores a lightweight profile summary (not PII) for fast dashboard loads.
   */
  async warmActiveUserProfiles(limit = 100): Promise<void> {
    const { rows } = await pool.query<{
      user_id: string;
      tx_count: string;
      last_activity: Date;
    }>(
      `SELECT user_id, COUNT(*) AS tx_count, MAX(created_at) AS last_activity
       FROM transactions
       WHERE user_id IS NOT NULL
         AND created_at >= NOW() - INTERVAL '7 days'
       GROUP BY user_id
       ORDER BY tx_count DESC
       LIMIT $1`,
      [limit],
    );

    if (rows.length === 0) {
      logger.info("[CacheWarming] No active users found to warm");
      return;
    }

    await Promise.allSettled(
      rows.map(async (r) => {
        const key = `user-profile:${r.user_id}`;
        // Store lightweight activity summary — full profile is fetched on demand
        await layeredCache.set(
          key,
          {
            userId: r.user_id,
            txCount: parseInt(r.tx_count, 10),
            lastActivity: r.last_activity,
          },
          // 15-minute TTL — stale is fine for activity summary
          900,
        );
      }),
    );

    logger.info(
      { count: rows.length },
      "[CacheWarming] Active user profiles warmed",
    );
  }

  /**
   * Run all warming tasks concurrently. Failures per task are captured and
   * returned rather than thrown, so one broken task does not abort others.
   */
  async warmAll(): Promise<WarmingResult> {
    if (this.isWarming) {
      logger.warn("[CacheWarming] warmAll() called while already warming — skipping");
      return { success: [], failed: [{ name: "warmAll", error: "Already running" }], durationMs: 0 };
    }

    this.isWarming = true;
    const startMs = Date.now();
    const successNames: string[] = [];
    const failedTasks: Array<{ name: string; error: string }> = [];

    const tasks: WarmingTask[] = [
      { name: "exchangeRates",       fn: () => this.warmExchangeRates() },
      { name: "generalStats",        fn: () => this.warmGeneralStats() },
      { name: "activeUserProfiles",  fn: () => this.warmActiveUserProfiles() },
    ];

    await Promise.allSettled(
      tasks.map(async (task) => {
        try {
          await task.fn();
          successNames.push(task.name);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failedTasks.push({ name: task.name, error: message });
          logger.warn({ task: task.name, err }, "[CacheWarming] Task failed");
        }
      }),
    );

    this.isWarming = false;
    const durationMs = Date.now() - startMs;

    logger.info(
      { success: successNames, failed: failedTasks, durationMs },
      "[CacheWarming] warmAll() complete",
    );

    return { success: successNames, failed: failedTasks, durationMs };
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  /**
   * Start a periodic re-warming interval.
   * Default: every 4 minutes (keeps exchange rates within their 5-min TTL).
   */
  startScheduledWarming(intervalMs = 4 * 60 * 1000): void {
    if (this.warmingTimer) {
      logger.warn("[CacheWarming] Scheduled warming already running");
      return;
    }

    logger.info({ intervalMs }, "[CacheWarming] Starting scheduled warming");
    this.warmingTimer = setInterval(() => {
      this.warmAll().catch((err) =>
        logger.error({ err }, "[CacheWarming] Scheduled warmAll failed"),
      );
    }, intervalMs);
  }

  /**
   * Stop the periodic re-warming interval.
   */
  stopScheduledWarming(): void {
    if (this.warmingTimer) {
      clearInterval(this.warmingTimer);
      this.warmingTimer = null;
      logger.info("[CacheWarming] Scheduled warming stopped");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

export const cacheWarmingService = new CacheWarmingService();
