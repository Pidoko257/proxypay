/**
 * Transaction Funnel Metrics Service — issue #262
 *
 * Tracks the transaction conversion funnel:
 *   initiated → verified → processing → completed | failed | cancelled
 *
 * Exposes Prometheus gauges/counters so Grafana can plot:
 *   - Funnel conversion at daily / hourly / real-time granularity
 *   - Drop-off stage identification (where transactions die)
 *   - Drill-down via transaction_id / provider / type labels
 *
 * The service also exposes a REST endpoint that returns the current funnel
 * snapshot (suitable for embedding in any analytics UI).
 */

import { Counter, Gauge } from "prom-client";
import { register as globalRegistry } from "../utils/metrics";
import { queryRead } from "../config/database";
import { redisClient } from "../config/redis";

// ---------------------------------------------------------------------------
// Funnel stage types
// ---------------------------------------------------------------------------

export type FunnelStage =
  | "initiated"
  | "verified"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "refunded";

export interface FunnelSnapshot {
  provider: string;
  type: string;
  initiated: number;
  verified: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** verified / initiated */
  verification_rate: number;
  /** processing / verified */
  processing_rate: number;
  /** completed / processing */
  completion_rate: number;
  /** completed / initiated — end-to-end conversion */
  overall_conversion_rate: number;
  /** stage with the biggest absolute drop-off */
  biggest_drop_off_stage: string;
}

export interface FunnelGranularity {
  granularity: "hourly" | "daily";
  from: string;
  to: string;
  snapshots: Array<{ period: string } & Omit<FunnelSnapshot, "provider" | "type">>;
}

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

/** Tracks every stage transition for real-time funnel view. */
export const funnelStageTransitions = new Counter({
  name: "transaction_funnel_stage_transitions_total",
  help: "Total transaction stage transitions for funnel analysis",
  labelNames: ["provider", "type", "from_stage", "to_stage"] as const,
  registers: [globalRegistry],
});

/** Current count of transactions at each funnel stage. */
export const funnelStageCurrentCount = new Gauge({
  name: "transaction_funnel_stage_current",
  help: "Current number of transactions at each funnel stage",
  labelNames: ["provider", "type", "stage"] as const,
  registers: [globalRegistry],
});

/** End-to-end conversion rate gauge — updated on each completion. */
export const funnelConversionRate = new Gauge({
  name: "transaction_funnel_conversion_rate",
  help: "Transaction conversion rate (completed / initiated) by provider and type",
  labelNames: ["provider", "type"] as const,
  registers: [globalRegistry],
});

/** Drop-off counter per stage — makes it easy to alert on sudden spikes. */
export const funnelDropOffTotal = new Counter({
  name: "transaction_funnel_drop_off_total",
  help: "Total transactions that dropped off at each funnel stage",
  labelNames: ["provider", "type", "stage"] as const,
  registers: [globalRegistry],
});

// ---------------------------------------------------------------------------
// Cache config
// ---------------------------------------------------------------------------

const FUNNEL_CACHE_TTL_SECONDS = 60; // 1-minute cache for DB queries
const CACHE_KEY_PREFIX = "funnel:snapshot";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const transactionFunnelService = {
  /**
   * Record a stage transition for a transaction.
   * Call this from the transaction state machine / update handler.
   */
  recordTransition(
    provider: string,
    type: "deposit" | "withdrawal" | string,
    fromStage: FunnelStage,
    toStage: FunnelStage,
  ): void {
    funnelStageTransitions.inc({ provider, type, from_stage: fromStage, to_stage: toStage });

    // Drop-off: any transition to failed/cancelled is a drop-off from the prior stage
    if (toStage === "failed" || toStage === "cancelled") {
      funnelDropOffTotal.inc({ provider, type, stage: fromStage });
    }
  },

  /**
   * Update the stage current-count gauges.
   * Call this after persisting a transaction state change.
   */
  setStageCount(
    provider: string,
    type: string,
    stage: FunnelStage,
    count: number,
  ): void {
    funnelStageCurrentCount.set({ provider, type, stage }, count);
  },

  /**
   * Update the overall conversion rate gauge.
   */
  updateConversionRate(provider: string, type: string, rate: number): void {
    funnelConversionRate.set({ provider, type }, rate);
  },

  /**
   * Query the database for a funnel snapshot at the given granularity.
   * Results are cached in Redis for FUNNEL_CACHE_TTL_SECONDS.
   */
  async getFunnelSnapshot(
    granularity: "hourly" | "daily" = "daily",
    lookbackHours = 24,
  ): Promise<FunnelSnapshot[]> {
    const cacheKey = `${CACHE_KEY_PREFIX}:${granularity}:${lookbackHours}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return JSON.parse(typeof cached === "string" ? cached : cached.toString());
    }

    const interval = granularity === "hourly" ? `${lookbackHours} hours` : `${lookbackHours} days`;

    const query = `
      SELECT
        COALESCE(provider, 'unknown')                                   AS provider,
        COALESCE(type, 'unknown')                                       AS type,
        COUNT(*)                                                        AS initiated,
        COUNT(*) FILTER (WHERE status NOT IN ('initiated'))             AS verified,
        COUNT(*) FILTER (WHERE status IN ('processing','completed','refunded')) AS processing,
        COUNT(*) FILTER (WHERE status = 'completed')                    AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')                       AS failed,
        COUNT(*) FILTER (WHERE status = 'cancelled')                    AS cancelled
      FROM transactions
      WHERE created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY provider, type
      ORDER BY initiated DESC
    `;

    try {
      const result = await queryRead<{
        provider: string;
        type: string;
        initiated: string;
        verified: string;
        processing: string;
        completed: string;
        failed: string;
        cancelled: string;
      }>(query, []);

      const snapshots: FunnelSnapshot[] = result.rows.map((row) => {
        const initiated = parseInt(row.initiated, 10);
        const verified = parseInt(row.verified, 10);
        const processing = parseInt(row.processing, 10);
        const completed = parseInt(row.completed, 10);
        const failed = parseInt(row.failed, 10);
        const cancelled = parseInt(row.cancelled, 10);

        const verificationRate = initiated > 0 ? verified / initiated : 0;
        const processingRate = verified > 0 ? processing / verified : 0;
        const completionRate = processing > 0 ? completed / processing : 0;
        const overallRate = initiated > 0 ? completed / initiated : 0;

        // Find the stage with the biggest absolute drop-off
        const dropOffs: Array<{ stage: string; drop: number }> = [
          { stage: "verification", drop: initiated - verified },
          { stage: "processing", drop: verified - processing },
          { stage: "completion", drop: processing - completed },
        ];
        dropOffs.sort((a, b) => b.drop - a.drop);
        const biggestDropOff = dropOffs[0]?.stage ?? "none";

        // Push gauges for Prometheus
        transactionFunnelService.setStageCount(row.provider, row.type, "initiated", initiated);
        transactionFunnelService.setStageCount(row.provider, row.type, "completed", completed);
        transactionFunnelService.setStageCount(row.provider, row.type, "failed", failed);
        transactionFunnelService.updateConversionRate(row.provider, row.type, overallRate);

        return {
          provider: row.provider,
          type: row.type,
          initiated,
          verified,
          processing,
          completed,
          failed,
          cancelled,
          verification_rate: Math.round(verificationRate * 10000) / 10000,
          processing_rate: Math.round(processingRate * 10000) / 10000,
          completion_rate: Math.round(completionRate * 10000) / 10000,
          overall_conversion_rate: Math.round(overallRate * 10000) / 10000,
          biggest_drop_off_stage: biggestDropOff,
        };
      });

      await redisClient.setex(cacheKey, FUNNEL_CACHE_TTL_SECONDS, JSON.stringify(snapshots));
      return snapshots;
    } catch {
      return [];
    }
  },

  /**
   * Query time-series funnel data for sparkline / trend charts.
   * Returns one row per period bucket (hour or day).
   */
  async getFunnelTimeSeries(
    granularity: "hourly" | "daily" = "daily",
    lookbackHours = 48,
  ): Promise<FunnelGranularity> {
    const cacheKey = `${CACHE_KEY_PREFIX}:timeseries:${granularity}:${lookbackHours}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return JSON.parse(typeof cached === "string" ? cached : cached.toString());
    }

    const truncUnit = granularity === "hourly" ? "hour" : "day";
    const interval = `${lookbackHours} hours`;

    const query = `
      SELECT
        DATE_TRUNC('${truncUnit}', created_at) AS period,
        COUNT(*)                                                         AS initiated,
        COUNT(*) FILTER (WHERE status NOT IN ('initiated'))              AS verified,
        COUNT(*) FILTER (WHERE status IN ('processing','completed','refunded')) AS processing,
        COUNT(*) FILTER (WHERE status = 'completed')                     AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')                        AS failed,
        COUNT(*) FILTER (WHERE status = 'cancelled')                     AS cancelled
      FROM transactions
      WHERE created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY DATE_TRUNC('${truncUnit}', created_at)
      ORDER BY period ASC
    `;

    const now = new Date();
    const from = new Date(now.getTime() - lookbackHours * 3600 * 1000);

    try {
      const result = await queryRead<{
        period: string;
        initiated: string;
        verified: string;
        processing: string;
        completed: string;
        failed: string;
        cancelled: string;
      }>(query, []);

      const snapshots = result.rows.map((row) => {
        const initiated = parseInt(row.initiated, 10);
        const verified = parseInt(row.verified, 10);
        const processing = parseInt(row.processing, 10);
        const completed = parseInt(row.completed, 10);
        const failed = parseInt(row.failed, 10);
        const cancelled = parseInt(row.cancelled, 10);

        const dropOffs = [
          { stage: "verification", drop: initiated - verified },
          { stage: "processing", drop: verified - processing },
          { stage: "completion", drop: processing - completed },
        ];
        dropOffs.sort((a, b) => b.drop - a.drop);

        return {
          period: new Date(row.period).toISOString(),
          initiated,
          verified,
          processing,
          completed,
          failed,
          cancelled,
          verification_rate: initiated > 0 ? Math.round((verified / initiated) * 10000) / 10000 : 0,
          processing_rate: verified > 0 ? Math.round((processing / verified) * 10000) / 10000 : 0,
          completion_rate: processing > 0 ? Math.round((completed / processing) * 10000) / 10000 : 0,
          overall_conversion_rate: initiated > 0 ? Math.round((completed / initiated) * 10000) / 10000 : 0,
          biggest_drop_off_stage: dropOffs[0]?.stage ?? "none",
        };
      });

      const response: FunnelGranularity = {
        granularity,
        from: from.toISOString(),
        to: now.toISOString(),
        snapshots,
      };

      await redisClient.setex(cacheKey, FUNNEL_CACHE_TTL_SECONDS, JSON.stringify(response));
      return response;
    } catch {
      return { granularity, from: from.toISOString(), to: now.toISOString(), snapshots: [] };
    }
  },
};
