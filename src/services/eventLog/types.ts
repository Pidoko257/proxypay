/**
 * Event Log Types and Interfaces
 *
 * Defines the schema for events stored in NoSQL databases
 * for high-volume, scalable event logging.
 */

/**
 * Event categories for classification
 */
export enum EventCategory {
  TRANSACTION = "transaction",
  USER = "user",
  AUTH = "auth",
  PAYMENT = "payment",
  COMPLIANCE = "compliance",
  PROVIDER = "provider",
  SYSTEM = "system",
  SECURITY = "security",
  AUDIT = "audit",
  ERROR = "error",
}

/**
 * Event severity levels
 */
export enum EventSeverity {
  DEBUG = "debug",
  INFO = "info",
  WARNING = "warning",
  ERROR = "error",
  CRITICAL = "critical",
}

/**
 * Core event structure for NoSQL storage
 * Optimized for write-heavy, query-flexible scenarios
 */
export interface Event {
  // Partition key (used by both Cosmos DB and DynamoDB)
  partitionKey: string; // Format: "YYYY-MM-DD" for time-series partitioning

  // Sort key (used by both Cosmos DB and DynamoDB)
  sortKey: string; // Format: `${timestamp}#${eventId}` for ordering

  // Unique identifier
  id: string; // UUID v4

  // Event metadata
  timestamp: number; // Unix milliseconds (ISO-8601 string also stored)
  timestampISO: string; // ISO-8601 format for queries
  category: EventCategory;
  severity: EventSeverity;
  source: string; // Service/component that generated the event

  // Event details
  type: string; // Specific event type (e.g., "payment.initiated", "user.login")
  title: string; // Human-readable title
  description: string; // Detailed description
  metadata: Record<string, unknown>; // Custom fields (varies per event type)

  // Reference IDs for correlation
  correlationId?: string; // Trace ID across distributed system
  transactionId?: string; // Associated transaction ID
  userId?: string; // Associated user ID
  providerId?: string; // Associated provider (mtn, airtel, orange)

  // Context information
  ipAddress?: string; // Client IP address
  userAgent?: string; // Client user agent
  region?: string; // Geographic region
  requestPath?: string; // HTTP request path

  // Status tracking
  status?: "pending" | "completed" | "failed" | "retry";
  errorCode?: string; // Error code if applicable
  errorMessage?: string; // Error message if applicable

  // Performance metrics
  durationMs?: number; // Operation duration in milliseconds
  retryCount?: number; // Number of retries
  attempt?: number; // Current attempt number

  // Tags for filtering
  tags?: string[]; // Custom tags for categorization
  environment?: "development" | "staging" | "production";

  // TTL for automatic expiration (optional)
  ttl?: number; // Seconds until expiration (Cosmos DB and DynamoDB support)

  // Versioning
  version: number; // Event schema version
  createdAt: number; // Creation timestamp (duplicate of timestamp for consistency)
  updatedAt?: number; // Last update timestamp
}

/**
 * Event write batch for bulk operations
 */
export interface EventBatch {
  events: Event[];
  timestamp: number;
  count: number;
}

/**
 * Query parameters for filtering events
 */
export interface EventQuery {
  // Date range (ISO-8601 or Unix timestamp)
  startDate?: string | number;
  endDate?: string | number;

  // Partitioning
  partitionKey?: string; // For time-series queries

  // Filtering
  category?: EventCategory | EventCategory[];
  severity?: EventSeverity | EventSeverity[];
  source?: string | string[];
  type?: string | string[];
  status?: string;
  tags?: string[];

  // Correlation
  correlationId?: string;
  transactionId?: string;
  userId?: string;
  providerId?: string;

  // Pagination
  limit?: number; // Default: 100
  offset?: number; // Default: 0

  // Sorting
  sortBy?: "timestamp" | "severity" | "category";
  sortOrder?: "asc" | "desc";
}

/**
 * Query response with pagination
 */
export interface EventQueryResponse {
  events: Event[];
  count: number;
  total?: number;
  hasMore?: boolean;
  nextOffset?: number;
  query: EventQuery;
}

/**
 * Statistics/aggregation results
 */
export interface EventStats {
  period: {
    startDate: string;
    endDate: string;
  };
  categoryCounts: Record<EventCategory, number>;
  severityCounts: Record<EventSeverity, number>;
  errorCounts: Record<string, number>; // By error code
  sourceBreakdown: Record<string, number>;
  averageResponseTime?: number;
  p50ResponseTime?: number;
  p95ResponseTime?: number;
  p99ResponseTime?: number;
}

/**
 * Event log provider interface
 * Implemented by Cosmos DB and DynamoDB adapters
 */
export interface IEventLogProvider {
  // Write operations
  write(event: Event): Promise<void>;
  writeBatch(batch: Event[]): Promise<void>;

  // Query operations
  query(params: EventQuery): Promise<EventQueryResponse>;
  queryByCorrelationId(correlationId: string): Promise<Event[]>;
  queryByTransactionId(transactionId: string): Promise<Event[]>;
  queryByUserId(userId: string): Promise<Event[]>;

  // Aggregation
  getStats(
    startDate: string | number,
    endDate: string | number
  ): Promise<EventStats>;

  // Admin operations
  deleteOldEvents(beforeDate: string | number): Promise<number>;
  getStorageStats(): Promise<{
    documentCount: number;
    storageUsedMB: number;
  }>;

  // Health check
  healthCheck(): Promise<boolean>;

  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Configuration for event log provider
 */
export interface EventLogConfig {
  provider: "cosmos" | "dynamodb";
  batchSize?: number; // Default: 100
  batchIntervalMs?: number; // Default: 5000ms
  retryAttempts?: number; // Default: 3
  retryDelayMs?: number; // Default: 1000ms

  // Cosmos DB specific
  cosmosDb?: {
    endpoint: string;
    key: string;
    databaseId: string;
    containerId: string;
    partitionKey: string;
    throughput?: number; // RU/s for provisioned throughput
  };

  // DynamoDB specific
  dynamodb?: {
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    endpoint?: string; // For local testing
    tableName: string;
    billingMode?: "PAY_PER_REQUEST" | "PROVISIONED";
    provisionedThroughput?: {
      readCapacityUnits: number;
      writeCapacityUnits: number;
    };
  };

  // Common options
  enableBatching?: boolean;
  enableMetrics?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
}

/**
 * Event log metrics
 */
export interface EventLogMetrics {
  eventsWritten: number;
  eventsQueried: number;
  averageWriteLatencyMs: number;
  averageQueryLatencyMs: number;
  failedWrites: number;
  failedQueries: number;
  batchCount: number;
  lastFlushTime: number;
}
