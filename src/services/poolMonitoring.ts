/**
 * Database connection pool monitoring and metrics
 * Tracks pool utilization, alerts on saturation, and optimizes connections
 */

import { Pool } from "pg";
import { Counter, Gauge, Histogram } from "prom-client";
import { logger } from "../utils/logger";

export interface PoolMetrics {
  activeConnections: number;
  idleConnections: number;
  totalConnections: number;
  queueDepth: number;
  utilizationPercent: number;
  saturation: boolean;
}

interface PoolConfig {
  maxConnections: number;
  idleTimeoutMs: number;
  saturationThreshold?: number; // Default 80%
  alertThreshold?: number; // Default 90%
}

/**
 * Prometheus metrics
 */
export const dbPoolMetrics = {
  activeConnections: new Gauge({
    name: "db_pool_active_connections",
    help: "Number of active database connections",
    labelNames: ["pool"],
  }),

  idleConnections: new Gauge({
    name: "db_pool_idle_connections",
    help: "Number of idle database connections",
    labelNames: ["pool"],
  }),

  totalConnections: new Gauge({
    name: "db_pool_total_connections",
    help: "Total database connections",
    labelNames: ["pool"],
  }),

  queueDepth: new Gauge({
    name: "db_pool_queue_depth",
    help: "Number of queries waiting for a connection",
    labelNames: ["pool"],
  }),

  utilizationPercent: new Gauge({
    name: "db_pool_utilization_percent",
    help: "Pool utilization percentage",
    labelNames: ["pool"],
  }),

  saturationAlerts: new Counter({
    name: "db_pool_saturation_alerts_total",
    help: "Number of pool saturation alerts",
    labelNames: ["pool", "severity"],
  }),

  connectionErrors: new Counter({
    name: "db_pool_connection_errors_total",
    help: "Number of connection errors",
    labelNames: ["pool", "error_type"],
  }),

  connectionDuration: new Histogram({
    name: "db_pool_connection_duration_seconds",
    help: "Connection acquisition duration",
    labelNames: ["pool"],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0],
  }),

  queryDuration: new Histogram({
    name: "db_query_duration_seconds",
    help: "Query execution duration",
    labelNames: ["pool", "query_type"],
    buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0],
  }),
};

/**
 * Pool monitor manages a single connection pool and its metrics
 */
export class PoolMonitor {
  private pool: Pool;
  private poolName: string;
  private config: Required<PoolConfig>;
  private metricsInterval: NodeJS.Timer | null = null;
  private lastQueueDepth = 0;

  constructor(
    pool: Pool,
    poolName: string,
    config: PoolConfig = {},
  ) {
    this.pool = pool;
    this.poolName = poolName;
    this.config = {
      maxConnections: config.maxConnections || 100,
      idleTimeoutMs: config.idleTimeoutMs || 30000,
      saturationThreshold: config.saturationThreshold || 80,
      alertThreshold: config.alertThreshold || 90,
    };
  }

  /**
   * Get current pool metrics
   */
  getMetrics(): PoolMetrics {
    const poolObj = this.pool as any;
    const active = poolObj._clients?.length || 0;
    const idle = poolObj._idleClients?.length || 0;
    const total = active + idle;
    const queueDepth = poolObj._queue?.length || 0;
    const utilizationPercent = (active / this.config.maxConnections) * 100;

    return {
      activeConnections: active,
      idleConnections: idle,
      totalConnections: total,
      queueDepth,
      utilizationPercent: Math.round(utilizationPercent),
      saturation: utilizationPercent > this.config.saturationThreshold,
    };
  }

  /**
   * Validate idle connections before reuse
   */
  async validateIdleConnections(): Promise<void> {
    try {
      const client = await this.pool.connect();

      try {
        // Quick health check query
        await client.query("SELECT 1");
      } finally {
        client.release();
      }
    } catch (error) {
      logger.warn("Idle connection validation failed", {
        pool: this.poolName,
        error: String(error),
      });

      dbPoolMetrics.connectionErrors.inc({
        pool: this.poolName,
        error_type: "validation_failed",
      });
    }
  }

  /**
   * Start monitoring pool metrics
   */
  startMonitoring(intervalMs: number = 10000): void {
    if (this.metricsInterval) {
      return; // Already monitoring
    }

    this.metricsInterval = setInterval(() => {
      try {
        const metrics = this.getMetrics();

        // Update Prometheus metrics
        dbPoolMetrics.activeConnections.set(
          { pool: this.poolName },
          metrics.activeConnections,
        );
        dbPoolMetrics.idleConnections.set(
          { pool: this.poolName },
          metrics.idleConnections,
        );
        dbPoolMetrics.totalConnections.set(
          { pool: this.poolName },
          metrics.totalConnections,
        );
        dbPoolMetrics.queueDepth.set(
          { pool: this.poolName },
          metrics.queueDepth,
        );
        dbPoolMetrics.utilizationPercent.set(
          { pool: this.poolName },
          metrics.utilizationPercent,
        );

        // Check for saturation
        if (metrics.saturation) {
          dbPoolMetrics.saturationAlerts.inc(
            {
              pool: this.poolName,
              severity:
                metrics.utilizationPercent > this.config.alertThreshold
                  ? "critical"
                  : "warning",
            },
          );

          logger.warn("Connection pool saturation detected", {
            pool: this.poolName,
            utilization: `${metrics.utilizationPercent}%`,
            active: metrics.activeConnections,
            max: this.config.maxConnections,
          });
        }

        // Monitor queue depth spikes
        if (
          metrics.queueDepth > this.lastQueueDepth * 1.5 &&
          metrics.queueDepth > 5
        ) {
          logger.warn("Connection queue depth spike", {
            pool: this.poolName,
            depth: metrics.queueDepth,
            previousDepth: this.lastQueueDepth,
          });
        }

        this.lastQueueDepth = metrics.queueDepth;

        // Periodic validation of idle connections
        if (
          Math.random() < 0.1 && // 10% of checks
          metrics.idleConnections > 0
        ) {
          this.validateIdleConnections().catch((error) =>
            logger.error("Validation error", { error: String(error) }),
          );
        }
      } catch (error) {
        logger.error("Pool monitoring error", {
          pool: this.poolName,
          error: String(error),
        });
      }
    }, intervalMs);

    logger.info("Pool monitoring started", {
      pool: this.poolName,
      interval: intervalMs,
    });
  }

  /**
   * Stop monitoring pool metrics
   */
  stopMonitoring(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
      logger.info("Pool monitoring stopped", { pool: this.poolName });
    }
  }

  /**
   * Get pool configuration recommendations
   */
  getConfigRecommendations(): Record<string, any> {
    const metrics = this.getMetrics();

    const avgConcurrency = metrics.activeConnections;
    const recommendedMax = Math.ceil(avgConcurrency * 1.5); // 50% buffer

    return {
      current: {
        max: this.config.maxConnections,
        current_utilization: `${metrics.utilizationPercent}%`,
      },
      recommendations: {
        recommended_max: recommendedMax,
        ideal_min: Math.max(5, Math.ceil(this.config.maxConnections * 0.2)),
        ideal_max: Math.min(200, recommendedMax),
        reason:
          metrics.utilizationPercent > 80
            ? "Current pool is over-utilized"
            : "Current pool sizing is adequate",
      },
      tuning_tips: [
        "Monitor queue depth during peak traffic",
        "Increase max connections if queue_depth > 10",
        "Reduce timeout if idle connections exceed max * 0.3",
        "Consider connection pooling proxy (PgBouncer) for production",
      ],
    };
  }
}

/**
 * Global pool monitoring manager
 */
export class PoolMonitoringManager {
  private monitors: Map<string, PoolMonitor> = new Map();

  /**
   * Register a pool for monitoring
   */
  register(
    pool: Pool,
    name: string,
    config?: PoolConfig,
  ): PoolMonitor {
    const monitor = new PoolMonitor(pool, name, config);
    this.monitors.set(name, monitor);
    monitor.startMonitoring();
    return monitor;
  }

  /**
   * Get monitor for pool
   */
  getMonitor(name: string): PoolMonitor | undefined {
    return this.monitors.get(name);
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): Record<string, PoolMetrics> {
    const result: Record<string, PoolMetrics> = {};

    for (const [name, monitor] of this.monitors) {
      result[name] = monitor.getMetrics();
    }

    return result;
  }

  /**
   * Stop all monitoring
   */
  stopAll(): void {
    for (const monitor of this.monitors.values()) {
      monitor.stopMonitoring();
    }

    this.monitors.clear();
    logger.info("All pool monitoring stopped");
  }
}

/**
 * Global instance
 */
export const poolMonitoringManager = new PoolMonitoringManager();
