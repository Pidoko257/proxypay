import { pool } from "../config/database";
import {
  dbQueryBaselineTimeGauge,
  dbQueryExecutionHistogram,
  dbQueryExecutionTimeGauge,
  dbQuerySlowdownAlertsTotal,
} from "../utils/metrics";
import { notifySlackAlert } from "./loggers";

export interface QueryBaselineRecord {
  id: string;
  queryName: string;
  baselineMs: number;
  avgDurationMs: number;
  sampleCount: number;
  lastExecutionMs: number;
  slowdownCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export class QueryBaselineService {
  private static instance: QueryBaselineService;
  private baselinesInMemory: Map<string, number> = new Map();
  private readonly SLOWDOWN_THRESHOLD_RATIO = 2.0; // Alert on 2x+ slowdown

  private constructor() {}

  public static getInstance(): QueryBaselineService {
    if (!QueryBaselineService.instance) {
      QueryBaselineService.instance = new QueryBaselineService();
    }
    return QueryBaselineService.instance;
  }

  /**
   * Load baselines from database into memory cache
   */
  public async loadBaselines(): Promise<void> {
    try {
      const result = await pool.query<{ query_name: string; baseline_ms: number }>(
        "SELECT query_name, baseline_ms FROM query_performance_baselines",
      );
      for (const row of result.rows) {
        this.baselinesInMemory.set(row.query_name, Number(row.baseline_ms));
        dbQueryBaselineTimeGauge.labels(row.query_name).set(Number(row.baseline_ms));
      }
    } catch (err: any) {
      console.error("[query-baseline] Failed to load baselines from database:", err?.message || err);
    }
  }

  /**
   * Record query execution time, record metrics, and trigger alerts if 2x+ slowdown occurs
   */
  public async recordQueryExecution(
    queryName: string,
    durationMs: number,
  ): Promise<{ isSlowdown: boolean; ratio: number }> {
    // 1. Record Prometheus metrics
    dbQueryExecutionTimeGauge.labels(queryName).set(durationMs);
    dbQueryExecutionHistogram.labels(queryName).observe(durationMs / 1000);

    let baselineMs = this.baselinesInMemory.get(queryName);
    let isSlowdown = false;
    let ratio = 1.0;

    // Check if baseline exists and if current duration is 2x+ baseline
    if (baselineMs && baselineMs > 0) {
      ratio = durationMs / baselineMs;
      if (ratio >= this.SLOWDOWN_THRESHOLD_RATIO) {
        isSlowdown = true;
        dbQuerySlowdownAlertsTotal.labels(queryName).inc();
        const alertMsg = `[DB QUERY SLOWDOWN ALERT] Query "${queryName}" degraded! Took ${durationMs.toFixed(
          2,
        )}ms (${ratio.toFixed(2)}x baseline of ${baselineMs.toFixed(2)}ms). Possible missing index or data bloat.`;
        console.warn(alertMsg);
        notifySlackAlert(alertMsg);
      }
    }

    // 2. Persist execution stats & calculate updated baseline using exponential moving average
    try {
      const existing = await pool.query<QueryBaselineRecord>(
        "SELECT * FROM query_performance_baselines WHERE query_name = $1",
        [queryName],
      );

      if (existing.rows.length === 0) {
        // Initial baseline creation
        await pool.query(
          `INSERT INTO query_performance_baselines (query_name, baseline_ms, avg_duration_ms, sample_count, last_execution_ms, slowdown_count)
           VALUES ($1, $2, $2, 1, $2, 0)`,
          [queryName, durationMs],
        );
        this.baselinesInMemory.set(queryName, durationMs);
        dbQueryBaselineTimeGauge.labels(queryName).set(durationMs);
      } else {
        const row = existing.rows[0];
        const prevCount = Number(row.sampleCount || 0);
        const prevBaseline = Number(row.baselineMs || durationMs);
        const prevSlowdown = Number(row.slowdownCount || 0);

        // Exponential moving average update for baseline (alpha = 0.15) to maintain plan stability
        const alpha = 0.15;
        const newBaseline = prevCount < 5 ? (prevBaseline * prevCount + durationMs) / (prevCount + 1) : prevBaseline * (1 - alpha) + durationMs * alpha;
        const newCount = prevCount + 1;
        const newSlowdownCount = isSlowdown ? prevSlowdown + 1 : prevSlowdown;

        await pool.query(
          `UPDATE query_performance_baselines
           SET baseline_ms = $1,
               avg_duration_ms = $2,
               sample_count = $3,
               last_execution_ms = $4,
               slowdown_count = $5,
               updated_at = CURRENT_TIMESTAMP
           WHERE query_name = $6`,
          [newBaseline, (Number(row.avgDurationMs || 0) * prevCount + durationMs) / newCount, newCount, durationMs, newSlowdownCount, queryName],
        );

        this.baselinesInMemory.set(queryName, newBaseline);
        dbQueryBaselineTimeGauge.labels(queryName).set(newBaseline);
      }
    } catch (dbErr: any) {
      console.error(`[query-baseline] Failed to persist query baseline for "${queryName}":`, dbErr?.message || dbErr);
    }

    return { isSlowdown, ratio };
  }

  /**
   * Get all query baseline records for Grafana/Dashboard tracking
   */
  public async getAllBaselines(): Promise<QueryBaselineRecord[]> {
    const result = await pool.query<QueryBaselineRecord>(
      "SELECT * FROM query_performance_baselines ORDER BY query_name ASC",
    );
    return result.rows;
  }
}

export const queryBaselineService = QueryBaselineService.getInstance();
