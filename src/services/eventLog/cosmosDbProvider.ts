/**
 * Cosmos DB Event Log Provider
 *
 * Implements event logging for Azure Cosmos DB with:
 * - Automatic partitioning by date for scalability
 * - Batch writes for throughput optimization
 * - TTL-based automatic data expiration
 * - Full query flexibility
 */

import { CosmosClient, Container, Database } from "@azure/cosmos";
import logger from "../../utils/logger";
import {
  Event,
  EventQuery,
  EventQueryResponse,
  EventStats,
  IEventLogProvider,
  EventLogConfig,
} from "./types";
import { v4 as uuidv4 } from "uuid";

/**
 * Cosmos DB implementation of event log provider
 */
export class CosmosDbEventLogProvider implements IEventLogProvider {
  private client: CosmosClient | null = null;
  private database: Database | null = null;
  private container: Container | null = null;
  private config: EventLogConfig;
  private batch: Event[] = [];
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(config: EventLogConfig) {
    if (!config.cosmosDb) {
      throw new Error("Cosmos DB configuration is required");
    }
    this.config = config;
  }

  /**
   * Initialize connection to Cosmos DB
   */
  async connect(): Promise<void> {
    try {
      const cosmosConfig = this.config.cosmosDb!;

      // Create client
      this.client = new CosmosClient({
        endpoint: cosmosConfig.endpoint,
        key: cosmosConfig.key,
      });

      // Connect to database
      const { database } = await this.client.databases.createIfNotExists({
        id: cosmosConfig.databaseId,
      });
      this.database = database;

      // Create container with TTL enabled
      const { container } = await database.containers.createIfNotExists({
        id: cosmosConfig.containerId,
        partitionKey: { paths: ["/partitionKey"] },
        defaultTtl: 2592000, // 30 days default TTL
        indexingPolicy: {
          indexingMode: "consistent",
          automatic: true,
          includedPaths: [
            { path: "/*" },
            { path: "/timestamp/*" },
            { path: "/category/*" },
            { path: "/severity/*" },
            { path: "/userId/*" },
            { path: "/transactionId/*" },
            { path: "/correlationId/*" },
          ],
        },
      });
      this.container = container;

      logger.info("Connected to Cosmos DB", {
        endpoint: cosmosConfig.endpoint,
        database: cosmosConfig.databaseId,
        container: cosmosConfig.containerId,
      });
    } catch (error) {
      logger.error("Failed to connect to Cosmos DB", { error });
      throw error;
    }
  }

  /**
   * Write single event
   */
  async write(event: Event): Promise<void> {
    if (!this.container) {
      throw new Error("Event log provider not connected");
    }

    // Enrich event
    const enrichedEvent = this.enrichEvent(event);

    // Batch or immediate write
    if (this.config.enableBatching !== false) {
      this.batch.push(enrichedEvent);
      this.scheduleFlush();
    } else {
      await this.container.items.create(enrichedEvent);
    }
  }

  /**
   * Write batch of events
   */
  async writeBatch(events: Event[]): Promise<void> {
    if (!this.container) {
      throw new Error("Event log provider not connected");
    }

    const enrichedEvents = events.map((e) => this.enrichEvent(e));

    // Batch size limit (Cosmos DB bulk insert max)
    const batchSize = this.config.batchSize || 100;

    for (let i = 0; i < enrichedEvents.length; i += batchSize) {
      const batch = enrichedEvents.slice(i, i + batchSize);

      try {
        // Use bulk operations for better throughput
        const operations = batch.map((event) => ({
          operationType: "Create",
          resourceBody: event,
        }));

        await this.container.items.bulk(operations);

        logger.debug("Batch written to Cosmos DB", {
          count: batch.length,
          totalEvents: enrichedEvents.length,
        });
      } catch (error) {
        logger.error("Failed to write batch to Cosmos DB", {
          error,
          batchSize: batch.length,
        });
        throw error;
      }
    }
  }

  /**
   * Query events
   */
  async query(params: EventQuery): Promise<EventQueryResponse> {
    if (!this.container) {
      throw new Error("Event log provider not connected");
    }

    const limit = params.limit || 100;
    const offset = params.offset || 0;

    // Build query
    const whereConditions: string[] = [];
    const queryParams: { name: string; value: unknown }[] = [];

    if (params.partitionKey) {
      whereConditions.push("c.partitionKey = @partitionKey");
      queryParams.push({ name: "@partitionKey", value: params.partitionKey });
    }

    if (params.startDate || params.endDate) {
      const startTs = this.toUnixTimestamp(params.startDate);
      const endTs = this.toUnixTimestamp(params.endDate);

      if (startTs) {
        whereConditions.push("c.timestamp >= @startDate");
        queryParams.push({ name: "@startDate", value: startTs });
      }
      if (endTs) {
        whereConditions.push("c.timestamp <= @endDate");
        queryParams.push({ name: "@endDate", value: endTs });
      }
    }

    if (params.category) {
      const categories = Array.isArray(params.category)
        ? params.category
        : [params.category];
      whereConditions.push(`c.category IN (${categories.map((_, i) => `@cat${i}`).join(", ")})`);
      categories.forEach((cat, i) => {
        queryParams.push({ name: `@cat${i}`, value: cat });
      });
    }

    if (params.severity) {
      const severities = Array.isArray(params.severity)
        ? params.severity
        : [params.severity];
      whereConditions.push(`c.severity IN (${severities.map((_, i) => `@sev${i}`).join(", ")})`);
      severities.forEach((sev, i) => {
        queryParams.push({ name: `@sev${i}`, value: sev });
      });
    }

    if (params.transactionId) {
      whereConditions.push("c.transactionId = @transactionId");
      queryParams.push({ name: "@transactionId", value: params.transactionId });
    }

    if (params.userId) {
      whereConditions.push("c.userId = @userId");
      queryParams.push({ name: "@userId", value: params.userId });
    }

    if (params.correlationId) {
      whereConditions.push("c.correlationId = @correlationId");
      queryParams.push({ name: "@correlationId", value: params.correlationId });
    }

    // Build SQL query
    const whereClause = whereConditions.length
      ? "WHERE " + whereConditions.join(" AND ")
      : "";
    const orderBy = params.sortBy
      ? `ORDER BY c.${params.sortBy} ${params.sortOrder || "DESC"}`
      : "ORDER BY c.timestamp DESC";

    const sql = `
      SELECT c FROM c ${whereClause} ${orderBy}
      OFFSET @offset LIMIT @limit
    `;

    queryParams.push({ name: "@offset", value: offset });
    queryParams.push({ name: "@limit", value: limit });

    try {
      const query = this.container.items.query(sql, {
        parameters: queryParams,
      });

      const { resources } = await query.fetchAll();

      return {
        events: resources as Event[],
        count: resources.length,
        hasMore: resources.length === limit,
        nextOffset: offset + limit,
        query: params,
      };
    } catch (error) {
      logger.error("Failed to query events from Cosmos DB", { error, sql });
      throw error;
    }
  }

  /**
   * Query events by correlation ID
   */
  async queryByCorrelationId(correlationId: string): Promise<Event[]> {
    const response = await this.query({
      correlationId,
      limit: 1000,
    });
    return response.events;
  }

  /**
   * Query events by transaction ID
   */
  async queryByTransactionId(transactionId: string): Promise<Event[]> {
    const response = await this.query({
      transactionId,
      limit: 1000,
    });
    return response.events;
  }

  /**
   * Query events by user ID
   */
  async queryByUserId(userId: string): Promise<Event[]> {
    const response = await this.query({
      userId,
      limit: 1000,
    });
    return response.events;
  }

  /**
   * Get statistics
   */
  async getStats(
    startDate: string | number,
    endDate: string | number
  ): Promise<EventStats> {
    if (!this.container) {
      throw new Error("Event log provider not connected");
    }

    const startTs = this.toUnixTimestamp(startDate);
    const endTs = this.toUnixTimestamp(endDate);

    const sql = `
      SELECT
        c.category,
        c.severity,
        c.source,
        c.errorCode,
        c.durationMs,
        COUNT(1) as count
      FROM c
      WHERE c.timestamp >= @startDate AND c.timestamp <= @endDate
      GROUP BY c.category, c.severity, c.source, c.errorCode, c.durationMs
    `;

    try {
      const query = this.container.items.query(sql, {
        parameters: [
          { name: "@startDate", value: startTs },
          { name: "@endDate", value: endTs },
        ],
      });

      const { resources } = await query.fetchAll();

      // Aggregate results
      const stats: EventStats = {
        period: {
          startDate: new Date(startTs!).toISOString(),
          endDate: new Date(endTs!).toISOString(),
        },
        categoryCounts: {},
        severityCounts: {},
        errorCounts: {},
        sourceBreakdown: {},
      };

      const durations: number[] = [];

      for (const result of resources) {
        // Category counts
        stats.categoryCounts[result.category] =
          (stats.categoryCounts[result.category] || 0) + result.count;

        // Severity counts
        stats.severityCounts[result.severity] =
          (stats.severityCounts[result.severity] || 0) + result.count;

        // Error counts
        if (result.errorCode) {
          stats.errorCounts[result.errorCode] =
            (stats.errorCounts[result.errorCode] || 0) + result.count;
        }

        // Source breakdown
        stats.sourceBreakdown[result.source] =
          (stats.sourceBreakdown[result.source] || 0) + result.count;

        // Response times (if available)
        if (result.durationMs) {
          durations.push(result.durationMs);
        }
      }

      // Calculate percentiles
      if (durations.length > 0) {
        durations.sort((a, b) => a - b);
        stats.averageResponseTime =
          durations.reduce((a, b) => a + b, 0) / durations.length;
        stats.p50ResponseTime = durations[Math.floor(durations.length * 0.5)];
        stats.p95ResponseTime = durations[Math.floor(durations.length * 0.95)];
        stats.p99ResponseTime = durations[Math.floor(durations.length * 0.99)];
      }

      return stats;
    } catch (error) {
      logger.error("Failed to get stats from Cosmos DB", { error });
      throw error;
    }
  }

  /**
   * Delete old events (before date)
   */
  async deleteOldEvents(beforeDate: string | number): Promise<number> {
    if (!this.container) {
      throw new Error("Event log provider not connected");
    }

    const beforeTs = this.toUnixTimestamp(beforeDate);

    const sql = `
      SELECT c.id, c.partitionKey
      FROM c
      WHERE c.timestamp < @beforeDate
    `;

    try {
      const query = this.container.items.query(sql, {
        parameters: [{ name: "@beforeDate", value: beforeTs }],
      });

      const { resources } = await query.fetchAll();
      let deletedCount = 0;

      for (const doc of resources) {
        await this.container.item(doc.id, doc.partitionKey).delete();
        deletedCount++;
      }

      logger.info("Deleted old events from Cosmos DB", {
        count: deletedCount,
        beforeDate: new Date(beforeTs!).toISOString(),
      });

      return deletedCount;
    } catch (error) {
      logger.error("Failed to delete old events", { error });
      throw error;
    }
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<{
    documentCount: number;
    storageUsedMB: number;
  }> {
    if (!this.container) {
      throw new Error("Event log provider not connected");
    }

    try {
      const sql = "SELECT COUNT(1) as count FROM c";
      const query = this.container.items.query(sql);
      const { resources } = await query.fetchAll();

      return {
        documentCount: resources[0]?.count || 0,
        storageUsedMB: 0, // Cosmos DB doesn't expose this directly
      };
    } catch (error) {
      logger.error("Failed to get storage stats", { error });
      throw error;
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.container) {
        return false;
      }

      const sql = "SELECT 1";
      const query = this.container.items.query(sql);
      await query.fetchNext();
      return true;
    } catch (error) {
      logger.error("Event log provider health check failed", { error });
      return false;
    }
  }

  /**
   * Disconnect from Cosmos DB
   */
  async disconnect(): Promise<void> {
    // Flush pending batch
    await this.flush();

    // Close client
    if (this.client) {
      await this.client.dispose();
      this.client = null;
    }

    logger.info("Disconnected from Cosmos DB");
  }

  // ========================================================================
  // PRIVATE METHODS
  // ========================================================================

  /**
   * Enrich event with required fields
   */
  private enrichEvent(event: Event): Event {
    const now = Date.now();
    const dateStr = new Date(now).toISOString().split("T")[0]; // YYYY-MM-DD

    return {
      ...event,
      id: event.id || uuidv4(),
      partitionKey: event.partitionKey || dateStr,
      sortKey:
        event.sortKey ||
        `${now}#${event.id || uuidv4()}`,
      timestamp: event.timestamp || now,
      timestampISO: event.timestampISO || new Date(now).toISOString(),
      createdAt: event.createdAt || now,
      version: event.version || 1,
      ttl: event.ttl || 2592000, // 30 days
    };
  }

  /**
   * Schedule batch flush
   */
  private scheduleFlush(): void {
    if (this.batchTimer) {
      return; // Already scheduled
    }

    const batchInterval = this.config.batchIntervalMs || 5000;
    const batchSize = this.config.batchSize || 100;

    // Flush if batch size reached
    if (this.batch.length >= batchSize) {
      this.flush().catch((error) =>
        logger.error("Failed to flush batch", { error })
      );
      return;
    }

    // Schedule flush on timer
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      if (this.batch.length > 0) {
        this.flush().catch((error) =>
          logger.error("Failed to flush batch", { error })
        );
      }
    }, batchInterval);
  }

  /**
   * Flush pending batch
   */
  private async flush(): Promise<void> {
    if (this.batch.length === 0) {
      return;
    }

    const events = this.batch;
    this.batch = [];

    try {
      await this.writeBatch(events);
    } catch (error) {
      logger.error("Failed to flush event batch", {
        error,
        count: events.length,
      });
      // Re-queue on failure (simple approach)
      this.batch.unshift(...events);
      throw error;
    }
  }

  /**
   * Convert date to Unix timestamp
   */
  private toUnixTimestamp(date?: string | number): number | null {
    if (!date) return null;

    if (typeof date === "number") {
      return date;
    }

    if (typeof date === "string") {
      // Try parsing as ISO-8601
      const ms = Date.parse(date);
      if (!isNaN(ms)) {
        return ms;
      }
    }

    return null;
  }
}
