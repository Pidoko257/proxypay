/**
 * Database Query Logging Types
 *
 * Comprehensive type definitions for query monitoring and performance tracking
 */

/**
 * Query execution status
 */
export enum QueryStatus {
  SUCCESS = "success",
  FAILED = "failed",
  TIMEOUT = "timeout",
  SLOW = "slow",
}

/**
 * Query type classification
 */
export enum QueryType {
  SELECT = "SELECT",
  INSERT = "INSERT",
  UPDATE = "UPDATE",
  DELETE = "DELETE",
  TRANSACTION = "TRANSACTION",
  DDL = "DDL",
  OTHER = "OTHER",
}

/**
 * Core query log entry
 */
export interface QueryLog {
  // Identification
  id: string; // UUID
  timestamp: number; // Unix milliseconds
  timestampISO: string; // ISO-8601

  // Query details
  query: string; // Full or truncated query
  queryType: QueryType;
  queryHash?: string; // Hash of query for grouping
  table?: string; // Primary table affected
  tables?: string[]; // All tables involved

  // Execution metrics
  durationMs: number;
  durationNs?: number; // High-precision nanoseconds

  // Status
  status: QueryStatus;
  rowsAffected?: number;
  rowsReturned?: number;

  // Performance
  planningTimeMs?: number;
  executionTimeMs?: number;
  indexes?: string[];

  // Context
  userId?: string;
  sessionId?: string;
  correlationId?: string;
  source?: string; // Service/function that executed query

  // Error information
  error?: {
    code?: string;
    message: string;
    severity?: "WARNING" | "ERROR" | "FATAL";
  };

  // Database information
  database?: string;
  schema?: string;
  host?: string;

  // Parameters (sanitized)
  paramCount?: number;
  params?: Array<string | number | null>;

  // Caching info
  cacheHit?: boolean;
  cachedResult?: boolean;

  // Tags for categorization
  tags?: string[];
  isReadOnly?: boolean;
  isCritical?: boolean;

  // Environment
  environment?: "development" | "staging" | "production";

  // Aggregation
  slowQueryThresholdMs?: number;
  isSlowQuery?: boolean;

  version: number;
}

/**
 * Query performance statistics
 */
export interface QueryStats {
  query: string;
  queryHash: string;
  queryType: QueryType;
  tables: string[];

  // Execution stats
  executionCount: number;
  totalDurationMs: number;
  averageDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;

  // Percentiles
  p50DurationMs: number;
  p75DurationMs: number;
  p90DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;

  // Success/failure
  successCount: number;
  failureCount: number;
  successRate: number;

  // Row operations
  totalRowsAffected: number;
  averageRowsAffected: number;
  totalRowsReturned: number;
  averageRowsReturned: number;

  // Error breakdown
  errorCodes: Record<string, number>;
  mostCommonError?: string;

  // Slowness
  slowQueryCount: number;
  slowQueryPercentage: number;
  lastExecutedAt: Date;
  firstExecutedAt: Date;

  // Cache info
  cacheHitCount?: number;
  cacheHitRate?: number;
}

/**
 * Query performance alerts
 */
export interface QueryAlert {
  id: string;
  timestamp: number;
  alertType:
    | "slow_query"
    | "query_failure"
    | "high_error_rate"
    | "table_scan"
    | "missing_index"
    | "high_latency";
  severity: "info" | "warning" | "error" | "critical";
  query: string;
  message: string;
  metrics: Record<string, number | string>;
  recommendations?: string[];
  acknowledged: boolean;
}

/**
 * Query optimization suggestion
 */
export interface OptimizationSuggestion {
  id: string;
  queryHash: string;
  query: string;
  issue: string;
  suggestion: string;
  estimatedImprovement: number; // Percentage
  priority: "low" | "medium" | "high" | "critical";
  indexSuggestion?: {
    table: string;
    columns: string[];
    unique: boolean;
  };
}

/**
 * Query configuration
 */
export interface QueryLoggerConfig {
  // Thresholds
  slowQueryThresholdMs?: number; // Default: 1000ms
  verySlowQueryThresholdMs?: number; // Default: 5000ms
  criticalQueryThresholdMs?: number; // Default: 10000ms

  // Logging
  enableQueryLogging?: boolean; // Default: true
  enableSlowQueryLogging?: boolean; // Default: true
  enableErrorQueryLogging?: boolean; // Default: true
  logQueryParams?: boolean; // Default: false (security)
  logFullQueries?: boolean; // Default: true in dev, false in prod

  // Storage
  storageProvider?: "memory" | "database" | "redis"; // Default: memory
  maxMemoryLogSize?: number; // Default: 10000
  retentionDays?: number; // Default: 7

  // Monitoring
  enableMetrics?: boolean; // Default: true
  enableAlerting?: boolean; // Default: true
  enableAnalysis?: boolean; // Default: true

  // Performance
  batchSize?: number; // Default: 100
  flushIntervalMs?: number; // Default: 5000ms

  // Filter/Exclude
  excludePatterns?: RegExp[];
  excludeTables?: string[];
  includeTables?: string[];

  // Environment
  environment?: "development" | "staging" | "production";
}

/**
 * Query logger interface
 */
export interface IQueryLogger {
  // Log operations
  logQuery(query: QueryLog): Promise<void>;
  logQueryBatch(queries: QueryLog[]): Promise<void>;

  // Retrieval
  getQueryLogs(
    filter?: Partial<QueryLog>,
    limit?: number
  ): Promise<QueryLog[]>;
  getQueryStats(): Promise<QueryStats[]>;
  getQueryStatsByTable(table: string): Promise<QueryStats[]>;

  // Analysis
  analyzePerformance(
    startDate?: Date,
    endDate?: Date
  ): Promise<QueryStats[]>;
  identifySlowQueries(topN?: number): Promise<QueryStats[]>;
  identifyFailingQueries(): Promise<QueryStats[]>;

  // Alerts
  getAlerts(unacknowledgedOnly?: boolean): Promise<QueryAlert[]>;
  acknowledgeAlert(alertId: string): Promise<void>;

  // Suggestions
  getOptimizationSuggestions(): Promise<OptimizationSuggestion[]>;

  // Administration
  clearLogs(beforeDate?: Date): Promise<number>;
  getStorageStats(): Promise<{
    count: number;
    sizeBytes: number;
  }>;
}

/**
 * Query execution context
 */
export interface QueryContext {
  userId?: string;
  sessionId?: string;
  correlationId?: string;
  source?: string;
  tags?: string[];
}

/**
 * Query performance metrics (for Prometheus)
 */
export interface QueryMetrics {
  queryDurationHistogram: {
    buckets: Record<number, number>; // Duration -> count
  };
  queryCountByType: Record<string, number>;
  queryErrorRate: number;
  slowQueryRate: number;
  averageQueryTime: number;
  p95QueryTime: number;
  p99QueryTime: number;
}

/**
 * Performance summary for reporting
 */
export interface PerformanceSummary {
  period: {
    startDate: Date;
    endDate: Date;
  };

  // Overall metrics
  totalQueries: number;
  averageExecutionTime: number;
  medianExecutionTime: number;
  p95ExecutionTime: number;
  p99ExecutionTime: number;

  // By type
  queryTypeBreakdown: Record<QueryType, number>;

  // Performance distribution
  fastQueries: number; // < 100ms
  normalQueries: number; // 100ms - 1s
  slowQueries: number; // 1s - 5s
  verySlowQueries: number; // > 5s

  // Errors
  totalErrors: number;
  errorRate: number;
  errorsByType: Record<string, number>;

  // Top queries
  topSlowestQueries: QueryStats[];
  topMostFrequentQueries: QueryStats[];
  topFailingQueries: QueryStats[];

  // Tables
  tableBreakdown: Record<string, {
    queryCount: number;
    averageTime: number;
  }>;

  // Recommendations
  criticalIssues: string[];
  recommendations: OptimizationSuggestion[];
}
