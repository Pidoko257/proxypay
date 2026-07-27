/**
 * Timeout Service
 *
 * Central manager for:
 *  - Recording timeout events to the `timeout_stats` database table
 *  - Computing aggregated timeout statistics (rate, p99, top offenders)
 *  - Alerting via PagerDuty when timeout rates cross configured thresholds
 *  - Exposing a statistics snapshot for the `/api/timeouts/stats` dashboard
 */

import logger from "../utils/logger";
import { OperationType } from "../utils/timeoutPolicies";
import { timeoutRecoveryTotal } from "../middleware/timeoutMetrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimeoutEvent {
  /** Operation type that timed out */
  operationType: OperationType;
  /** Request path */
  path: string;
  /** HTTP method */
  method: string;
  /** How long the request ran before being aborted (ms) */
  elapsedMs: number;
  /** Correlation ID from req.id */
  requestId?: string;
  /** Transaction ID if the request was transaction-related */
  transactionId?: string;
  /** ISO timestamp – defaults to now() */
  occurredAt?: string;
}

export interface TimeoutStats {
  /** Total timeouts recorded since the service started */
  totalTimeouts: number;
  /** Timeouts per operation type */
  byOperationType: Record<string, number>;
  /** Timeouts in the last 5-minute window */
  last5MinTimeouts: number;
  /** Timeouts in the last 60-minute window */
  lastHourTimeouts: number;
  /** Average elapsed time for timed-out requests (ms) */
  avgElapsedMs: number;
  /** Top 5 paths with the most timeouts */
  topPaths: Array<{ path: string; count: number }>;
  /** Current alert threshold */
  alertThresholdPerMinute: number;
  /** Whether an alert is currently active */
  alertActive: boolean;
  /** Timestamp of the last timeout event */
  lastTimeoutAt: string | null;
}

// ---------------------------------------------------------------------------
// In-process ring buffer for recent timeout events
// ---------------------------------------------------------------------------

const MAX_RING_BUFFER = 1_000;

interface StoredEvent extends TimeoutEvent {
  occurredAt: string; // always set
}

// ---------------------------------------------------------------------------
// TimeoutService class
// ---------------------------------------------------------------------------

export class TimeoutService {
  private ringBuffer: StoredEvent[] = [];
  private alertActive = false;
  private alertCheckIntervalMs: number;
  private alertThresholdPerMinute: number;
  private alertIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private pagerDutyEnabled: boolean;
  private dbEnabled: boolean;

  constructor() {
    this.alertThresholdPerMinute = parseInt(
      process.env.TIMEOUT_ALERT_THRESHOLD_PER_MIN ?? "5",
      10,
    );
    this.alertCheckIntervalMs = parseInt(
      process.env.TIMEOUT_ALERT_CHECK_INTERVAL_MS ?? "60000",
      10,
    );
    this.pagerDutyEnabled =
      !!process.env.PAGERDUTY_INTEGRATION_KEY &&
      process.env.NODE_ENV !== "test";
    this.dbEnabled = process.env.NODE_ENV !== "test";
  }

  // -------------------------------------------------------------------------
  // Core: record a timeout
  // -------------------------------------------------------------------------

  /**
   * Records a single timeout event.
   *
   * - Adds the event to the in-memory ring buffer.
   * - Persists to the `timeout_stats` table (non-blocking, errors swallowed).
   * - Checks alert thresholds.
   */
  async recordTimeout(event: TimeoutEvent): Promise<void> {
    const stored: StoredEvent = {
      ...event,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
    };

    // Ring-buffer
    this.ringBuffer.push(stored);
    if (this.ringBuffer.length > MAX_RING_BUFFER) {
      this.ringBuffer.shift();
    }

    logger.warn("Timeout event recorded", {
      operationType: event.operationType,
      path: event.path,
      method: event.method,
      elapsedMs: event.elapsedMs,
      requestId: event.requestId,
      transactionId: event.transactionId,
    });

    // Persist to DB (fire-and-forget)
    if (this.dbEnabled) {
      this.persistToDB(stored).catch((err) =>
        logger.error("Failed to persist timeout event to DB", { error: err }),
      );
    }

    // Check alert threshold
    await this.checkAlertThreshold();
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  /**
   * Returns an aggregated statistics snapshot based on the in-memory ring
   * buffer.  For historical data beyond the ring buffer use the DB queries in
   * `getHistoricalStats`.
   */
  getStats(): TimeoutStats {
    const now = Date.now();
    const window5m = now - 5 * 60_000;
    const window1h = now - 60 * 60_000;

    const last5 = this.ringBuffer.filter(
      (e) => new Date(e.occurredAt).getTime() > window5m,
    );
    const lastHour = this.ringBuffer.filter(
      (e) => new Date(e.occurredAt).getTime() > window1h,
    );

    const byOpType: Record<string, number> = {};
    for (const e of this.ringBuffer) {
      byOpType[e.operationType] = (byOpType[e.operationType] ?? 0) + 1;
    }

    const pathCounts: Record<string, number> = {};
    for (const e of this.ringBuffer) {
      pathCounts[e.path] = (pathCounts[e.path] ?? 0) + 1;
    }
    const topPaths = Object.entries(pathCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path, count]) => ({ path, count }));

    const totalElapsed = this.ringBuffer.reduce(
      (sum, e) => sum + e.elapsedMs,
      0,
    );
    const avgElapsedMs =
      this.ringBuffer.length > 0
        ? Math.round(totalElapsed / this.ringBuffer.length)
        : 0;

    const last = this.ringBuffer[this.ringBuffer.length - 1];

    return {
      totalTimeouts: this.ringBuffer.length,
      byOperationType: byOpType,
      last5MinTimeouts: last5.length,
      lastHourTimeouts: lastHour.length,
      avgElapsedMs,
      topPaths,
      alertThresholdPerMinute: this.alertThresholdPerMinute,
      alertActive: this.alertActive,
      lastTimeoutAt: last?.occurredAt ?? null,
    };
  }

  /**
   * Queries the `timeout_stats` table for historical aggregates.
   * Falls back gracefully if the DB is unavailable.
   */
  async getHistoricalStats(hours: number = 24): Promise<{
    totalTimeouts: number;
    byOperationType: Record<string, number>;
    hourlyBuckets: Array<{ hour: string; count: number }>;
  }> {
    if (!this.dbEnabled) {
      return { totalTimeouts: 0, byOperationType: {}, hourlyBuckets: [] };
    }
    try {
      const { pool } = await import("../config/database.js");
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();

      const [totals, hourly] = await Promise.all([
        pool.query<{ operation_type: string; cnt: string }>(
          `SELECT operation_type, COUNT(*) AS cnt
           FROM timeout_stats
           WHERE occurred_at >= $1
           GROUP BY operation_type`,
          [since],
        ),
        pool.query<{ bucket: string; cnt: string }>(
          `SELECT date_trunc('hour', occurred_at) AS bucket, COUNT(*) AS cnt
           FROM timeout_stats
           WHERE occurred_at >= $1
           GROUP BY bucket
           ORDER BY bucket`,
          [since],
        ),
      ]);

      const byOperationType: Record<string, number> = {};
      let totalTimeouts = 0;
      for (const row of totals.rows) {
        byOperationType[row.operation_type] = parseInt(row.cnt, 10);
        totalTimeouts += parseInt(row.cnt, 10);
      }

      const hourlyBuckets = hourly.rows.map((r) => ({
        hour: new Date(r.bucket).toISOString(),
        count: parseInt(r.cnt, 10),
      }));

      return { totalTimeouts, byOperationType, hourlyBuckets };
    } catch (err) {
      logger.error("Failed to query historical timeout stats", { error: err });
      return { totalTimeouts: 0, byOperationType: {}, hourlyBuckets: [] };
    }
  }

  // -------------------------------------------------------------------------
  // Alerting
  // -------------------------------------------------------------------------

  /**
   * Starts the background alert-check interval.  Call once at app startup.
   */
  startAlertMonitor(): void {
    if (this.alertIntervalHandle) return;
    this.alertIntervalHandle = setInterval(
      () => this.checkAlertThreshold(),
      this.alertCheckIntervalMs,
    );
    logger.info("Timeout alert monitor started", {
      thresholdPerMin: this.alertThresholdPerMinute,
      checkIntervalMs: this.alertCheckIntervalMs,
    });
  }

  /** Stops the alert monitor (for clean shutdown / tests). */
  stopAlertMonitor(): void {
    if (this.alertIntervalHandle) {
      clearInterval(this.alertIntervalHandle);
      this.alertIntervalHandle = null;
    }
  }

  private async checkAlertThreshold(): Promise<void> {
    const now = Date.now();
    const window1m = now - 60_000;
    const recentCount = this.ringBuffer.filter(
      (e) => new Date(e.occurredAt).getTime() > window1m,
    ).length;

    const shouldAlert = recentCount >= this.alertThresholdPerMinute;

    if (shouldAlert && !this.alertActive) {
      this.alertActive = true;
      logger.error("Timeout rate alert TRIGGERED", {
        timeoutsLastMinute: recentCount,
        threshold: this.alertThresholdPerMinute,
      });
      if (this.pagerDutyEnabled) {
        await this.firePagerDutyAlert(recentCount);
      }
    } else if (!shouldAlert && this.alertActive) {
      this.alertActive = false;
      logger.info("Timeout rate alert RESOLVED", {
        timeoutsLastMinute: recentCount,
      });
      if (this.pagerDutyEnabled) {
        await this.resolvePagerDutyAlert();
      }
    }
  }

  private async firePagerDutyAlert(recentCount: number): Promise<void> {
    try {
      const { PagerDutyService: PD } = await import("./pagerDutyService");
      const integrationKey = process.env.PAGERDUTY_INTEGRATION_KEY ?? "";
      const dedupKey = `${process.env.PAGERDUTY_DEDUP_KEY ?? "proxypay"}-timeout-rate`;

      const pd = new PD({
        integrationKey,
        dedupKey,
        enabled: true,
      });
      await (pd as any).sendEvent({
        routing_key: integrationKey,
        event_action: "trigger",
        dedup_key: dedupKey,
        payload: {
          summary: `Timeout rate exceeded: ${recentCount} timeouts/min (threshold: ${this.alertThresholdPerMinute})`,
          timestamp: new Date().toISOString(),
          severity: "critical",
          source: "proxypay-timeout-service",
          custom_details: {
            timeoutsLastMinute: recentCount,
            threshold: this.alertThresholdPerMinute,
            stats: this.getStats(),
          },
        },
      });
    } catch (err) {
      logger.error("Failed to fire PagerDuty timeout alert", { error: err });
    }
  }

  private async resolvePagerDutyAlert(): Promise<void> {
    try {
      const integrationKey = process.env.PAGERDUTY_INTEGRATION_KEY ?? "";
      const dedupKey = `${process.env.PAGERDUTY_DEDUP_KEY ?? "proxypay"}-timeout-rate`;
      // Simple HTTP resolve using axios
      const axios = (await import("axios")).default;
      await axios.post("https://events.pagerduty.com/v2/enqueue", {
        routing_key: integrationKey,
        event_action: "resolve",
        dedup_key: dedupKey,
        payload: {
          summary: "Timeout rate has returned below threshold",
          timestamp: new Date().toISOString(),
          severity: "info",
          source: "proxypay-timeout-service",
          custom_details: { stats: this.getStats() },
        },
      });
    } catch (err) {
      logger.error("Failed to resolve PagerDuty timeout alert", { error: err });
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async persistToDB(event: StoredEvent): Promise<void> {
    const { pool } = await import("../config/database.js");
    await pool.query(
      `INSERT INTO timeout_stats
         (operation_type, request_path, http_method, elapsed_ms,
          request_id, transaction_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        event.operationType,
        event.path,
        event.method,
        event.elapsedMs,
        event.requestId ?? null,
        event.transactionId ?? null,
        event.occurredAt,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Testing helpers
  // -------------------------------------------------------------------------

  /** Clears the in-memory ring buffer (test use only). */
  clearBuffer(): void {
    this.ringBuffer = [];
    this.alertActive = false;
  }

  /** Exposes the ring buffer length (test use only). */
  get bufferSize(): number {
    return this.ringBuffer.length;
  }
}

// Singleton
export const timeoutService = new TimeoutService();
