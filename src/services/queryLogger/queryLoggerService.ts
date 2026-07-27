/**
 * Query Logger Service
 *
 * Comprehensive database query logging and performance monitoring.
 * Tracks execution times, identifies slow queries, and provides optimization suggestions.
 */

import logger from "../../utils/logger";
import {
  QueryLog,
  QueryStats,
  QueryAlert,
  OptimizationSuggestion,
  QueryLoggerConfig,
  IQueryLogger,
  QueryType,
  QueryStatus,
  PerformanceSummary,
} from "./types";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

/**
 * Main Query Logger Service
 */
export class QueryLoggerService implements IQueryLogger {
  private config: QueryLoggerConfig;
  private logs: QueryLog[] = [];
  private stats: Map<string, QueryStats> = new Map();
  private alerts: QueryAlert[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private batch: QueryLog[] = [];

  // Default thresholds (ms)
  private readonly DEFAULT_SLOW_THRESHOLD = 1000;
  private readonly DEFAULT_VERY_SLOW_THRESHOLD = 5000;
  private readonly DEFAULT_CRITICAL_THRESHOLD = 10000;

  constructor(config: QueryLoggerConfig = {}) {
    this.config = {
      slowQueryThresholdMs: 1000,
      verySlowQueryThresholdMs: 5000,
      criticalQueryThresholdMs: 10000,
      enableQueryLogging: true,
      enableSlowQueryLogging: true,
      enableErrorQueryLogging: true,
      logQueryParams: false,
      logFullQueries: process.env.NODE_ENV !== "production",
      storageProvider: "memory",
      maxMemoryLogSize: 10000,
      retentionDays: 7,
      enableMetrics: true,
      enableAlerting: true,
      enableAnalysis: true,
      batchSize: 100,
      flushIntervalMs: 5000,
      ...config,
    };

    logger.info("Query logger service initialized", {
      config: {
        slowQueryThreshold: this.config.slowQueryThresholdMs,
        enableLogging: this.config.enableQueryLogging,
        environment: this.config.environment,
      },
    });
  }

  /**
   * Log a single query
   */
  async logQuery(query: QueryLog): Promise<void> {
    if (!this.config.enableQueryLogging) {
      return;
    }

    try {
      // Enrich query log
      const enrichedQuery = this.enrichQuery(query);

      // Check for alerts
      if (this.config.enableAlerting) {
        this.checkForAlerts(enrichedQuery);
      }

      // Batch or immediate log
      if (this.config.batchSize && this.config.batchSize > 1) {
        this.batch.push(enrichedQuery);
        this.scheduleFlush();
      } else {
        await this.storeQuery(enrichedQuery);
      }

      // Update stats
      if (this.config.enableAnalysis) {
        this.updateStats(enrichedQuery);
      }
    } catch (error) {
      logger.error("Failed to log query", { error });
    }
  }

  /**
   * Log batch of queries
   */
  async logQueryBatch(queries: QueryLog[]): Promise<void> {
    if (!this.config.enableQueryLogging) {
      return;
    }

    try {
      const enrichedQueries = queries.map((q) => this.enrichQuery(q));

      for (const query of enrichedQueries) {
        // Check for alerts
        if (this.config.enableAlerting) {
          this.checkForAlerts(query);
        }

        // Update stats
        if (this.config.enableAnalysis) {
          this.updateStats(query);
        }
      }

      // Store all
      await this.storeQueries(enrichedQueries);
    } catch (error) {
      logger.error("Failed to log query batch", { error, count: queries.length });
    }
  }

  /**
   * Get query logs with optional filtering
   */
  async getQueryLogs(
    filter?: Partial<QueryLog>,
    limit: number = 100
  ): Promise<QueryLog[]> {
    try {
      let results = [...this.logs];

      // Apply filters
      if (filter) {
        results = results.filter((log) => {
          if (filter.status && log.status !== filter.status) return false;
          if (filter.queryType && log.queryType !== filter.queryType) return false;
          if (filter.table && !log.tables?.includes(filter.table)) return false;
          if (filter.isSlowQuery && log.isSlowQuery !== filter.isSlowQuery)
            return false;
          if (filter.userId && log.userId !== filter.userId) return false;
          return true;
        });
      }

      // Sort by timestamp (newest first)
      results.sort((a, b) => b.timestamp - a.timestamp);

      // Limit results
      return results.slice(0, limit);
    } catch (error) {
      logger.error("Failed to get query logs", { error });
      return [];
    }
  }

  /**
   * Get statistics for all tracked queries
   */
  async getQueryStats(): Promise<QueryStats[]> {
    return Array.from(this.stats.values());
  }

  /**
   * Get statistics for queries on a specific table
   */
  async getQueryStatsByTable(table: string): Promise<QueryStats[]> {
    const stats: QueryStats[] = [];

    for (const stat of this.stats.values()) {
      if (stat.tables.includes(table)) {
        stats.push(stat);
      }
    }

    return stats.sort((a, b) => b.averageDurationMs - a.averageDurationMs);
  }

  /**
   * Analyze performance over a time period
   */
  async analyzePerformance(
    startDate?: Date,
    endDate?: Date
  ): Promise<QueryStats[]> {
    const start = startDate?.getTime() || 0;
    const end = endDate?.getTime() || Date.now();

    const filtered = this.logs.filter(
      (log) => log.timestamp >= start && log.timestamp <= end
    );

    // Rebuild stats from filtered logs
    const statsMap = new Map<string, QueryStats>();

    for (const log of filtered) {
      const key = log.queryHash || this.hashQuery(log.query);

      if (!statsMap.has(key)) {
        statsMap.set(key, {
          query: log.query,
          queryHash: key,
          queryType: log.queryType,
          tables: log.tables || [],
          executionCount: 0,
          totalDurationMs: 0,
          averageDurationMs: 0,
          minDurationMs: Infinity,
          maxDurationMs: 0,
          p50DurationMs: 0,
          p75DurationMs: 0,
          p90DurationMs: 0,
          p95DurationMs: 0,
          p99DurationMs: 0,
          successCount: 0,
          failureCount: 0,
          successRate: 0,
          totalRowsAffected: 0,
          averageRowsAffected: 0,
          totalRowsReturned: 0,
          averageRowsReturned: 0,
          errorCodes: {},
          slowQueryCount: 0,
          slowQueryPercentage: 0,
          lastExecutedAt: new Date(),
          firstExecutedAt: new Date(log.timestamp),
        });
      }

      const stats = statsMap.get(key)!;
      stats.executionCount++;
      stats.totalDurationMs += log.durationMs;
      stats.minDurationMs = Math.min(stats.minDurationMs, log.durationMs);
      stats.maxDurationMs = Math.max(stats.maxDurationMs, log.durationMs);

      if (log.status === QueryStatus.SUCCESS) {
        stats.successCount++;
      } else {
        stats.failureCount++;
        if (log.error?.code) {
          stats.errorCodes[log.error.code] =
            (stats.errorCodes[log.error.code] || 0) + 1;
        }
      }

      if (log.rowsAffected) {
        stats.totalRowsAffected += log.rowsAffected;
      }
      if (log.rowsReturned) {
        stats.totalRowsReturned += log.rowsReturned;
      }

      if (log.isSlowQuery) {
        stats.slowQueryCount++;
      }

      stats.lastExecutedAt = new Date(log.timestamp);
    }

    // Calculate derived metrics
    for (const stats of statsMap.values()) {
      stats.averageDurationMs = stats.totalDurationMs / stats.executionCount;
      stats.averageRowsAffected = stats.totalRowsAffected / stats.executionCount;
      stats.averageRowsReturned = stats.totalRowsReturned / stats.executionCount;
      stats.successRate = stats.successCount / stats.executionCount;
      stats.slowQueryPercentage =
        (stats.slowQueryCount / stats.executionCount) * 100;

      // Calculate percentiles
      const durations = filtered
        .filter((l) => l.queryHash === stats.queryHash)
        .map((l) => l.durationMs)
        .sort((a, b) => a - b);

      if (durations.length > 0) {
        stats.p50DurationMs = durations[Math.floor(durations.length * 0.5)];
        stats.p75DurationMs = durations[Math.floor(durations.length * 0.75)];
        stats.p90DurationMs = durations[Math.floor(durations.length * 0.9)];
        stats.p95DurationMs = durations[Math.floor(durations.length * 0.95)];
        stats.p99DurationMs = durations[Math.floor(durations.length * 0.99)];
      }

      // Find most common error
      if (Object.keys(stats.errorCodes).length > 0) {
        stats.mostCommonError = Object.entries(stats.errorCodes).sort(
          ([, a], [, b]) => b - a
        )[0]?.[0];
      }
    }

    return Array.from(statsMap.values());
  }

  /**
   * Identify slow queries
   */
  async identifySlowQueries(topN: number = 20): Promise<QueryStats[]> {
    const stats = await this.analyzePerformance();
    return stats
      .filter((s) => s.slowQueryCount > 0)
      .sort((a, b) => b.averageDurationMs - a.averageDurationMs)
      .slice(0, topN);
  }

  /**
   * Identify failing queries
   */
  async identifyFailingQueries(): Promise<QueryStats[]> {
    const stats = await this.analyzePerformance();
    return stats
      .filter((s) => s.failureCount > 0)
      .sort((a, b) => b.failureCount - a.failureCount);
  }

  /**
   * Get all alerts
   */
  async getAlerts(unacknowledgedOnly: boolean = false): Promise<QueryAlert[]> {
    if (unacknowledgedOnly) {
      return this.alerts.filter((a) => !a.acknowledged);
    }
    return [...this.alerts];
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(alertId: string): Promise<void> {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
    }
  }

  /**
   * Get optimization suggestions
   */
  async getOptimizationSuggestions(): Promise<OptimizationSuggestion[]> {
    const suggestions: OptimizationSuggestion[] = [];
    const slowQueries = await this.identifySlowQueries(50);

    for (const stats of slowQueries) {
      // Check for missing indexes
      if (stats.executionCount > 100 && stats.averageDurationMs > 2000) {
        suggestions.push({
          id: uuidv4(),
          queryHash: stats.queryHash,
          query: stats.query,
          issue: "Query is slow and executed frequently",
          suggestion: "Consider adding indexes on JOIN/WHERE columns",
          estimatedImprovement: 30,
          priority: "high",
          indexSuggestion: {
            table: stats.tables[0],
            columns: this.extractColumns(stats.query),
            unique: false,
          },
        });
      }

      // Check for potential full table scans
      if (
        stats.query.toLowerCase().includes("select *") &&
        stats.tables.length > 0
      ) {
        suggestions.push({
          id: uuidv4(),
          queryHash: stats.queryHash,
          query: stats.query,
          issue: "Query uses SELECT * which may be inefficient",
          suggestion: "Specify only required columns to reduce data transfer",
          estimatedImprovement: 15,
          priority: "medium",
        });
      }
    }

    return suggestions;
  }

  /**
   * Clear old logs
   */
  async clearLogs(beforeDate?: Date): Promise<number> {
    const cutoffTime = beforeDate
      ? beforeDate.getTime()
      : Date.now() - this.config.retentionDays! * 24 * 60 * 60 * 1000;

    const beforeCount = this.logs.length;
    this.logs = this.logs.filter((log) => log.timestamp > cutoffTime);
    const deletedCount = beforeCount - this.logs.length;

    logger.info("Cleared old query logs", {
      deletedCount,
      beforeDate: new Date(cutoffTime).toISOString(),
    });

    return deletedCount;
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<{ count: number; sizeBytes: number }> {
    let sizeBytes = 0;

    for (const log of this.logs) {
      sizeBytes += JSON.stringify(log).length;
    }

    return {
      count: this.logs.length,
      sizeBytes,
    };
  }

  /**
   * Get comprehensive performance summary
   */
  async getPerformanceSummary(
    startDate?: Date,
    endDate?: Date
  ): Promise<PerformanceSummary> {
    const stats = await this.analyzePerformance(startDate, endDate);
    const start = startDate || new Date(Date.now() - 24 * 60 * 60 * 1000);
    const end = endDate || new Date();

    const summary: PerformanceSummary = {
      period: { startDate: start, endDate: end },
      totalQueries: 0,
      averageExecutionTime: 0,
      medianExecutionTime: 0,
      p95ExecutionTime: 0,
      p99ExecutionTime: 0,
      queryTypeBreakdown: {} as Record<QueryType, number>,
      fastQueries: 0,
      normalQueries: 0,
      slowQueries: 0,
      verySlowQueries: 0,
      totalErrors: 0,
      errorRate: 0,
      errorsByType: {},
      topSlowestQueries: [],
      topMostFrequentQueries: [],
      topFailingQueries: [],
      tableBreakdown: {},
      criticalIssues: [],
      recommendations: [],
    };

    // Aggregate stats
    let totalDuration = 0;
    const allDurations: number[] = [];

    for (const stat of stats) {
      summary.totalQueries += stat.executionCount;
      totalDuration += stat.totalDurationMs;
      summary.totalErrors += stat.failureCount;

      // Query type breakdown
      summary.queryTypeBreakdown[stat.queryType] =
        (summary.queryTypeBreakdown[stat.queryType] || 0) + stat.executionCount;

      // Performance distribution
      if (stat.averageDurationMs < 100) {
        summary.fastQueries += stat.executionCount;
      } else if (stat.averageDurationMs < 1000) {
        summary.normalQueries += stat.executionCount;
      } else if (stat.averageDurationMs < 5000) {
        summary.slowQueries += stat.executionCount;
      } else {
        summary.verySlowQueries += stat.executionCount;
      }

      // Error breakdown
      for (const [code, count] of Object.entries(stat.errorCodes)) {
        summary.errorsByType[code] = (summary.errorsByType[code] || 0) + count;
      }

      // Table breakdown
      for (const table of stat.tables) {
        if (!summary.tableBreakdown[table]) {
          summary.tableBreakdown[table] = { queryCount: 0, averageTime: 0 };
        }
        summary.tableBreakdown[table].queryCount += stat.executionCount;
        summary.tableBreakdown[table].averageTime += stat.averageDurationMs;
      }

      // Collect durations for percentiles
      allDurations.push(stat.averageDurationMs);
    }

    // Calculate averages
    if (summary.totalQueries > 0) {
      summary.averageExecutionTime = totalDuration / summary.totalQueries;
      summary.errorRate = summary.totalErrors / summary.totalQueries;

      // Calculate percentiles
      allDurations.sort((a, b) => a - b);
      summary.medianExecutionTime = allDurations[Math.floor(allDurations.length * 0.5)];
      summary.p95ExecutionTime = allDurations[Math.floor(allDurations.length * 0.95)];
      summary.p99ExecutionTime = allDurations[Math.floor(allDurations.length * 0.99)];
    }

    // Top queries
    summary.topSlowestQueries = stats
      .sort((a, b) => b.averageDurationMs - a.averageDurationMs)
      .slice(0, 10);

    summary.topMostFrequentQueries = stats
      .sort((a, b) => b.executionCount - a.executionCount)
      .slice(0, 10);

    summary.topFailingQueries = stats
      .filter((s) => s.failureCount > 0)
      .sort((a, b) => b.failureCount - a.failureCount)
      .slice(0, 10);

    // Critical issues
    if (summary.p99ExecutionTime > this.config.criticalQueryThresholdMs!) {
      summary.criticalIssues.push(
        `P99 query time (${Math.round(summary.p99ExecutionTime)}ms) exceeds critical threshold`
      );
    }

    if (summary.errorRate > 0.05) {
      summary.criticalIssues.push(
        `Error rate (${(summary.errorRate * 100).toFixed(2)}%) exceeds threshold`
      );
    }

    // Recommendations
    summary.recommendations = await this.getOptimizationSuggestions();

    return summary;
  }

  // ========================================================================
  // PRIVATE METHODS
  // ========================================================================

  /**
   * Enrich query log with additional information
   */
  private enrichQuery(query: QueryLog): QueryLog {
    const now = Date.now();
    const isSlowQuery = query.durationMs > this.config.slowQueryThresholdMs!;

    return {
      ...query,
      id: query.id || uuidv4(),
      timestamp: query.timestamp || now,
      timestampISO: query.timestampISO || new Date(now).toISOString(),
      queryHash: query.queryHash || this.hashQuery(query.query),
      status: query.status || QueryStatus.SUCCESS,
      isSlowQuery,
      environment: query.environment || this.config.environment,
      slowQueryThresholdMs: this.config.slowQueryThresholdMs,
      version: 1,
    };
  }

  /**
   * Store query (with size limit)
   */
  private async storeQuery(query: QueryLog): Promise<void> {
    this.logs.push(query);

    // Maintain size limit
    if (this.logs.length > this.config.maxMemoryLogSize!) {
      this.logs.shift(); // Remove oldest
    }

    // Log slow queries if enabled
    if (query.isSlowQuery && this.config.enableSlowQueryLogging) {
      logger.warn("Slow query detected", {
        query: query.query,
        duration: query.durationMs,
        threshold: this.config.slowQueryThresholdMs,
        table: query.table,
      });
    }

    // Log errors if enabled
    if (
      query.status === QueryStatus.FAILED &&
      this.config.enableErrorQueryLogging
    ) {
      logger.error("Query failed", {
        query: query.query,
        error: query.error,
        duration: query.durationMs,
      });
    }
  }

  /**
   * Store multiple queries
   */
  private async storeQueries(queries: QueryLog[]): Promise<void> {
    for (const query of queries) {
      await this.storeQuery(query);
    }
  }

  /**
   * Update statistics for a query
   */
  private updateStats(query: QueryLog): void {
    const key = query.queryHash || this.hashQuery(query.query);

    let stats = this.stats.get(key);
    if (!stats) {
      stats = {
        query: query.query,
        queryHash: key,
        queryType: query.queryType,
        tables: query.tables || [],
        executionCount: 0,
        totalDurationMs: 0,
        averageDurationMs: 0,
        minDurationMs: Infinity,
        maxDurationMs: 0,
        p50DurationMs: 0,
        p75DurationMs: 0,
        p90DurationMs: 0,
        p95DurationMs: 0,
        p99DurationMs: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        totalRowsAffected: 0,
        averageRowsAffected: 0,
        totalRowsReturned: 0,
        averageRowsReturned: 0,
        errorCodes: {},
        slowQueryCount: 0,
        slowQueryPercentage: 0,
        lastExecutedAt: new Date(),
        firstExecutedAt: new Date(query.timestamp),
      };
      this.stats.set(key, stats);
    }

    // Update counts
    stats.executionCount++;
    stats.totalDurationMs += query.durationMs;
    stats.minDurationMs = Math.min(stats.minDurationMs, query.durationMs);
    stats.maxDurationMs = Math.max(stats.maxDurationMs, query.durationMs);
    stats.averageDurationMs = stats.totalDurationMs / stats.executionCount;

    if (query.status === QueryStatus.SUCCESS) {
      stats.successCount++;
    } else {
      stats.failureCount++;
      if (query.error?.code) {
        stats.errorCodes[query.error.code] =
          (stats.errorCodes[query.error.code] || 0) + 1;
      }
    }

    stats.successRate = stats.successCount / stats.executionCount;

    if (query.isSlowQuery) {
      stats.slowQueryCount++;
      stats.slowQueryPercentage =
        (stats.slowQueryCount / stats.executionCount) * 100;
    }

    stats.lastExecutedAt = new Date(query.timestamp);
  }

  /**
   * Check for alerts
   */
  private checkForAlerts(query: QueryLog): void {
    // Slow query alert
    if (
      query.isSlowQuery &&
      query.durationMs > this.config.verySlowQueryThresholdMs!
    ) {
      this.createAlert(
        "slow_query",
        "critical",
        query.query,
        `Query took ${query.durationMs}ms, exceeds threshold of ${this.config.verySlowQueryThresholdMs}ms`,
        {
          duration: query.durationMs,
          threshold: this.config.verySlowQueryThresholdMs!,
        }
      );
    }

    // Query failure alert
    if (query.status === QueryStatus.FAILED) {
      this.createAlert(
        "query_failure",
        "error",
        query.query,
        `Query failed: ${query.error?.message}`,
        {
          errorCode: query.error?.code,
          errorMessage: query.error?.message,
        }
      );
    }
  }

  /**
   * Create an alert
   */
  private createAlert(
    type: QueryAlert["alertType"],
    severity: QueryAlert["severity"],
    query: string,
    message: string,
    metrics: Record<string, number | string>
  ): void {
    const alert: QueryAlert = {
      id: uuidv4(),
      timestamp: Date.now(),
      alertType: type,
      severity,
      query,
      message,
      metrics,
      acknowledged: false,
    };

    this.alerts.push(alert);

    // Keep only recent alerts
    if (this.alerts.length > 1000) {
      this.alerts = this.alerts.slice(-1000);
    }

    logger.warn("Query alert created", { alert });
  }

  /**
   * Hash query for grouping identical queries
   */
  private hashQuery(query: string): string {
    // Normalize query (remove extra whitespace, convert to uppercase)
    const normalized = query
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();

    // Replace constants with placeholders
    const parameterized = normalized
      .replace(/'[^']*'/g, "'?'")
      .replace(/\d+/g, "?")
      .replace(/\$\d+/g, "$?");

    return crypto.createHash("md5").update(parameterized).digest("hex");
  }

  /**
   * Extract column names from query
   */
  private extractColumns(query: string): string[] {
    const columns: string[] = [];

    // Simple extraction - look for common patterns
    const whereMatch = query.match(/WHERE\s+(.+?)(?:GROUP|ORDER|LIMIT|$)/i);
    if (whereMatch) {
      const conditions = whereMatch[1].split(/\s+AND\s+/i);
      for (const condition of conditions) {
        const colMatch = condition.match(/(\w+)\s*[=<>]/);
        if (colMatch) {
          columns.push(colMatch[1]);
        }
      }
    }

    return [...new Set(columns)].slice(0, 5); // Top 5 unique columns
  }

  /**
   * Schedule batch flush
   */
  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }

    const batchSize = this.config.batchSize || 100;
    const flushInterval = this.config.flushIntervalMs || 5000;

    // Flush if batch size reached
    if (this.batch.length >= batchSize) {
      this.flush();
      return;
    }

    // Schedule flush on timer
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.batch.length > 0) {
        this.flush();
      }
    }, flushInterval);
  }

  /**
   * Flush pending batch
   */
  private async flush(): Promise<void> {
    if (this.batch.length === 0) {
      return;
    }

    const queries = this.batch;
    this.batch = [];

    try {
      await this.storeQueries(queries);
    } catch (error) {
      logger.error("Failed to flush query batch", {
        error,
        count: queries.length,
      });
      // Re-queue on failure
      this.batch.unshift(...queries);
    }
  }

  /**
   * Shutdown service
   */
  async shutdown(): Promise<void> {
    // Flush remaining batch
    await this.flush();

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    logger.info("Query logger service shutdown", {
      queriesLogged: this.logs.length,
    });
  }
}

/**
 * Singleton instance
 */
let queryLoggerInstance: QueryLoggerService | null = null;

/**
 * Get or create QueryLoggerService singleton
 */
export async function getQueryLogger(
  config?: QueryLoggerConfig
): Promise<QueryLoggerService> {
  if (!queryLoggerInstance && config) {
    queryLoggerInstance = new QueryLoggerService(config);
  }

  if (!queryLoggerInstance) {
    queryLoggerInstance = new QueryLoggerService();
  }

  return queryLoggerInstance;
}

export { QueryLoggerService };
