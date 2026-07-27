/**
 * Event Log Service
 *
 * High-level service for event logging with provider abstraction.
 * Supports both Cosmos DB and DynamoDB with automatic batching
 * and metrics tracking.
 */

import logger from "../../utils/logger";
import {
  Event,
  EventQuery,
  EventQueryResponse,
  EventStats,
  EventLogConfig,
  EventCategory,
  EventSeverity,
  EventLogMetrics,
} from "./types";
import { IEventLogProvider } from "./types";
import { CosmosDbEventLogProvider } from "./cosmosDbProvider";
import { DynamoDbEventLogProvider } from "./dynamodbProvider";
import { v4 as uuidv4 } from "uuid";

export class EventLogService {
  private provider: IEventLogProvider | null = null;
  private config: EventLogConfig;
  private metrics: EventLogMetrics = {
    eventsWritten: 0,
    eventsQueried: 0,
    averageWriteLatencyMs: 0,
    averageQueryLatencyMs: 0,
    failedWrites: 0,
    failedQueries: 0,
    batchCount: 0,
    lastFlushTime: Date.now(),
  };

  constructor(config: EventLogConfig) {
    this.config = config;
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    try {
      // Create appropriate provider
      if (this.config.provider === "cosmos") {
        this.provider = new CosmosDbEventLogProvider(this.config);
      } else if (this.config.provider === "dynamodb") {
        this.provider = new DynamoDbEventLogProvider(this.config);
      } else {
        throw new Error(`Unknown event log provider: ${this.config.provider}`);
      }

      // Connect to provider
      await this.provider.connect();

      // Health check
      const isHealthy = await this.provider.healthCheck();
      if (!isHealthy) {
        throw new Error("Event log provider health check failed");
      }

      logger.info("Event log service initialized", {
        provider: this.config.provider,
        batching: this.config.enableBatching !== false,
      });
    } catch (error) {
      logger.error("Failed to initialize event log service", { error });
      throw error;
    }
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    if (this.provider) {
      await this.provider.disconnect();
    }
    logger.info("Event log service shutdown", { metrics: this.metrics });
  }

  // ========================================================================
  // EVENT WRITING
  // ========================================================================

  /**
   * Log an event
   */
  async log(event: Partial<Event>): Promise<void> {
    const startTime = Date.now();

    try {
      if (!this.provider) {
        throw new Error("Event log service not initialized");
      }

      // Ensure required fields
      const completeEvent: Event = {
        id: event.id || uuidv4(),
        partitionKey: event.partitionKey || this.getDatePartition(),
        sortKey: event.sortKey || `${Date.now()}#${uuidv4()}`,
        timestamp: event.timestamp || Date.now(),
        timestampISO: event.timestampISO || new Date().toISOString(),
        category: event.category || EventCategory.SYSTEM,
        severity: event.severity || EventSeverity.INFO,
        source: event.source || "unknown",
        type: event.type || "unknown",
        title: event.title || "Event",
        description: event.description || "",
        metadata: event.metadata || {},
        version: event.version || 1,
        createdAt: Date.now(),
        ...event,
      };

      await this.provider.write(completeEvent);

      this.metrics.eventsWritten++;
      const duration = Date.now() - startTime;
      this.metrics.averageWriteLatencyMs =
        (this.metrics.averageWriteLatencyMs * (this.metrics.eventsWritten - 1) +
          duration) /
        this.metrics.eventsWritten;
    } catch (error) {
      this.metrics.failedWrites++;
      logger.error("Failed to log event", { error, event });
      throw error;
    }
  }

  /**
   * Log transaction event
   */
  async logTransaction(
    transactionId: string,
    type: string,
    data: Record<string, unknown>
  ): Promise<void> {
    await this.log({
      category: EventCategory.TRANSACTION,
      type: `transaction.${type}`,
      title: `Transaction ${type.toUpperCase()}`,
      description: `Transaction ${transactionId} ${type}`,
      transactionId,
      metadata: data,
      tags: ["transaction", type],
    });
  }

  /**
   * Log payment event
   */
  async logPayment(
    provider: string,
    type: string,
    amount: string,
    phoneNumber: string,
    data: Record<string, unknown>
  ): Promise<void> {
    await this.log({
      category: EventCategory.PAYMENT,
      type: `payment.${provider}.${type}`,
      title: `${provider.toUpperCase()} Payment ${type.toUpperCase()}`,
      description: `Payment of ${amount} to ${phoneNumber} via ${provider}`,
      providerId: provider,
      metadata: {
        provider,
        type,
        amount,
        phoneNumber: this.maskPhoneNumber(phoneNumber),
        ...data,
      },
      tags: ["payment", provider, type],
    });
  }

  /**
   * Log authentication event
   */
  async logAuth(
    userId: string,
    type: string,
    success: boolean,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.log({
      category: EventCategory.AUTH,
      type: `auth.${type}`,
      title: `Authentication ${type.toUpperCase()} ${success ? "SUCCESS" : "FAILED"}`,
      description: `User authentication attempt: ${type}`,
      severity: success ? EventSeverity.INFO : EventSeverity.WARNING,
      userId,
      status: success ? "completed" : "failed",
      metadata: {
        type,
        success,
        ...metadata,
      },
      tags: ["auth", type, success ? "success" : "failure"],
    });
  }

  /**
   * Log error event
   */
  async logError(
    error: Error | string,
    context?: Record<string, unknown>
  ): Promise<void> {
    const errorMessage = typeof error === "string" ? error : error.message;
    const errorCode = context?.errorCode as string | undefined;

    await this.log({
      category: EventCategory.ERROR,
      type: "error.application",
      title: "Application Error",
      description: errorMessage,
      severity: EventSeverity.ERROR,
      errorCode,
      errorMessage,
      metadata: {
        ...context,
        stack: typeof error === "string" ? undefined : error.stack,
      },
      tags: ["error", errorCode || "unknown"],
    });
  }

  /**
   * Log compliance event
   */
  async logCompliance(
    type: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await this.log({
      category: EventCategory.COMPLIANCE,
      type: `compliance.${type}`,
      title: `Compliance: ${type.toUpperCase()}`,
      description: `Compliance check: ${type}`,
      metadata: details,
      tags: ["compliance", type],
    });
  }

  /**
   * Log security event
   */
  async logSecurity(
    type: string,
    severity: EventSeverity,
    details: Record<string, unknown>
  ): Promise<void> {
    await this.log({
      category: EventCategory.SECURITY,
      type: `security.${type}`,
      title: `Security Event: ${type.toUpperCase()}`,
      description: `Security incident: ${type}`,
      severity,
      metadata: details,
      tags: ["security", type],
    });
  }

  /**
   * Batch log events
   */
  async logBatch(events: Partial<Event>[]): Promise<void> {
    if (!this.provider) {
      throw new Error("Event log service not initialized");
    }

    const startTime = Date.now();

    try {
      const completeEvents = events.map((event) => ({
        id: event.id || uuidv4(),
        partitionKey: event.partitionKey || this.getDatePartition(),
        sortKey: event.sortKey || `${Date.now()}#${uuidv4()}`,
        timestamp: event.timestamp || Date.now(),
        timestampISO: event.timestampISO || new Date().toISOString(),
        category: event.category || EventCategory.SYSTEM,
        severity: event.severity || EventSeverity.INFO,
        source: event.source || "unknown",
        type: event.type || "unknown",
        title: event.title || "Event",
        description: event.description || "",
        metadata: event.metadata || {},
        version: event.version || 1,
        createdAt: Date.now(),
        ...event,
      })) as Event[];

      await this.provider.writeBatch(completeEvents);

      this.metrics.eventsWritten += completeEvents.length;
      this.metrics.batchCount++;
      const duration = Date.now() - startTime;
      this.metrics.averageWriteLatencyMs =
        (this.metrics.averageWriteLatencyMs * this.metrics.eventsWritten +
          duration) /
        (this.metrics.eventsWritten + completeEvents.length);
    } catch (error) {
      this.metrics.failedWrites++;
      logger.error("Failed to log batch", { error, count: events.length });
      throw error;
    }
  }

  // ========================================================================
  // QUERYING
  // ========================================================================

  /**
   * Query events
   */
  async query(params: EventQuery): Promise<EventQueryResponse> {
    if (!this.provider) {
      throw new Error("Event log service not initialized");
    }

    const startTime = Date.now();

    try {
      const response = await this.provider.query(params);
      this.metrics.eventsQueried += response.count;

      const duration = Date.now() - startTime;
      this.metrics.averageQueryLatencyMs =
        (this.metrics.averageQueryLatencyMs * this.metrics.eventsQueried +
          duration) /
        (this.metrics.eventsQueried + response.count);

      return response;
    } catch (error) {
      this.metrics.failedQueries++;
      logger.error("Failed to query events", { error, params });
      throw error;
    }
  }

  /**
   * Query by correlation ID (trace)
   */
  async queryByCorrelationId(correlationId: string): Promise<Event[]> {
    if (!this.provider) {
      throw new Error("Event log service not initialized");
    }

    return this.provider.queryByCorrelationId(correlationId);
  }

  /**
   * Query by transaction ID
   */
  async queryByTransactionId(transactionId: string): Promise<Event[]> {
    if (!this.provider) {
      throw new Error("Event log service not initialized");
    }

    return this.provider.queryByTransactionId(transactionId);
  }

  /**
   * Query by user ID
   */
  async queryByUserId(userId: string): Promise<Event[]> {
    if (!this.provider) {
      throw new Error("Event log service not initialized");
    }

    return this.provider.queryByUserId(userId);
  }

  /**
   * Get statistics
   */
  async getStats(
    startDate: string | number,
    endDate: string | number
  ): Promise<EventStats> {
    if (!this.provider) {
      throw new Error("Event log service not initialized");
    }

    return this.provider.getStats(startDate, endDate);
  }

  // ========================================================================
  // ADMIN OPERATIONS
  // ========================================================================

  /**
   * Delete old events
   */
  async deleteOldEvents(beforeDate: string | number): Promise<number> {
    if (!this.provider) {
      throw new Error("Event log service not initialized");
    }

    return this.provider.deleteOldEvents(beforeDate);
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<{
    documentCount: number;
    storageUsedMB: number;
  }> {
    if (!this.provider) {
      throw new Error("Event log service not initialized");
    }

    return this.provider.getStorageStats();
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    if (!this.provider) {
      return false;
    }

    return this.provider.healthCheck();
  }

  /**
   * Get metrics
   */
  getMetrics(): EventLogMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      eventsWritten: 0,
      eventsQueried: 0,
      averageWriteLatencyMs: 0,
      averageQueryLatencyMs: 0,
      failedWrites: 0,
      failedQueries: 0,
      batchCount: 0,
      lastFlushTime: Date.now(),
    };
  }

  // ========================================================================
  // PRIVATE HELPERS
  // ========================================================================

  /**
   * Get date partition key (YYYY-MM-DD)
   */
  private getDatePartition(): string {
    return new Date().toISOString().split("T")[0];
  }

  /**
   * Mask phone number for logging
   */
  private maskPhoneNumber(phoneNumber: string): string {
    if (phoneNumber.length <= 4) return phoneNumber;
    return "*".repeat(phoneNumber.length - 4) + phoneNumber.slice(-4);
  }
}

/**
 * Singleton instance
 */
let eventLogServiceInstance: EventLogService | null = null;

/**
 * Get or create EventLogService singleton
 */
export async function getEventLogService(
  config?: EventLogConfig
): Promise<EventLogService> {
  if (!eventLogServiceInstance && config) {
    eventLogServiceInstance = new EventLogService(config);
    await eventLogServiceInstance.initialize();
  }

  if (!eventLogServiceInstance) {
    throw new Error("Event log service not initialized");
  }

  return eventLogServiceInstance;
}

/**
 * Export service instance
 */
export { EventLogService };
