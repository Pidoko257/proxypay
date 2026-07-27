/**
 * DynamoDB Event Log Provider
 *
 * Implements event logging for AWS DynamoDB with:
 * - On-demand billing for unpredictable workloads
 * - TTL-based automatic data expiration
 * - Global Secondary Indexes for flexible queries
 * - Batch write optimization
 */

import {
  DynamoDBClient,
  CreateTableCommand,
  PutItemCommand,
  BatchWriteItemCommand,
  QueryCommand,
  ScanCommand,
  DeleteItemCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
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
 * DynamoDB implementation of event log provider
 */
export class DynamoDbEventLogProvider implements IEventLogProvider {
  private client: DynamoDBClient | null = null;
  private config: EventLogConfig;
  private batch: Event[] = [];
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(config: EventLogConfig) {
    if (!config.dynamodb) {
      throw new Error("DynamoDB configuration is required");
    }
    this.config = config;
  }

  /**
   * Initialize connection to DynamoDB
   */
  async connect(): Promise<void> {
    try {
      const dynamoConfig = this.config.dynamodb!;

      // Create client
      this.client = new DynamoDBClient({
        region: dynamoConfig.region,
        ...(dynamoConfig.endpoint && { endpoint: dynamoConfig.endpoint }),
        ...(dynamoConfig.accessKeyId && {
          credentials: {
            accessKeyId: dynamoConfig.accessKeyId,
            secretAccessKey: dynamoConfig.secretAccessKey || "",
          },
        }),
      });

      // Create table if needed
      await this.ensureTable();

      logger.info("Connected to DynamoDB", {
        region: dynamoConfig.region,
        tableName: dynamoConfig.tableName,
      });
    } catch (error) {
      logger.error("Failed to connect to DynamoDB", { error });
      throw error;
    }
  }

  /**
   * Write single event
   */
  async write(event: Event): Promise<void> {
    if (!this.client) {
      throw new Error("Event log provider not connected");
    }

    // Enrich event
    const enrichedEvent = this.enrichEvent(event);

    // Batch or immediate write
    if (this.config.enableBatching !== false) {
      this.batch.push(enrichedEvent);
      this.scheduleFlush();
    } else {
      await this.putItem(enrichedEvent);
    }
  }

  /**
   * Write batch of events
   */
  async writeBatch(events: Event[]): Promise<void> {
    if (!this.client) {
      throw new Error("Event log provider not connected");
    }

    const enrichedEvents = events.map((e) => this.enrichEvent(e));
    const tableName = this.config.dynamodb!.tableName;

    // DynamoDB batch write limit is 25 items
    const batchWriteLimit = 25;

    for (let i = 0; i < enrichedEvents.length; i += batchWriteLimit) {
      const batch = enrichedEvents.slice(i, i + batchWriteLimit);

      try {
        const requestItems: Record<
          string,
          Array<{ PutRequest: { Item: Record<string, unknown> } }>
        > = {
          [tableName]: batch.map((event) => ({
            PutRequest: {
              Item: marshall(event, { removeUndefinedValues: true }),
            },
          })),
        };

        await this.client.send(
          new BatchWriteItemCommand({ RequestItems: requestItems })
        );

        logger.debug("Batch written to DynamoDB", {
          count: batch.length,
          totalEvents: enrichedEvents.length,
        });
      } catch (error) {
        logger.error("Failed to write batch to DynamoDB", {
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
    if (!this.client) {
      throw new Error("Event log provider not connected");
    }

    const tableName = this.config.dynamodb!.tableName;
    const limit = params.limit || 100;

    try {
      // If querying by partition key, use Query operation (efficient)
      if (params.partitionKey) {
        return await this.queryByPartition(params, tableName, limit);
      }

      // Otherwise use Scan (less efficient but flexible)
      return await this.scanEvents(params, tableName, limit);
    } catch (error) {
      logger.error("Failed to query events from DynamoDB", {
        error,
        params,
      });
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
    _startDate: string | number,
    _endDate: string | number
  ): Promise<EventStats> {
    // DynamoDB doesn't support aggregation directly
    // For production, use DynamoDB Streams + Lambda or Athena
    logger.warn("Statistics not implemented for DynamoDB", {
      hint: "Use DynamoDB Streams + Lambda or AWS Athena for aggregations",
    });

    return {
      period: {
        startDate: new Date(_startDate as any).toISOString(),
        endDate: new Date(_endDate as any).toISOString(),
      },
      categoryCounts: {},
      severityCounts: {},
      errorCounts: {},
      sourceBreakdown: {},
    };
  }

  /**
   * Delete old events (before date)
   */
  async deleteOldEvents(beforeDate: string | number): Promise<number> {
    if (!this.client) {
      throw new Error("Event log provider not connected");
    }

    const tableName = this.config.dynamodb!.tableName;
    const beforeTs = this.toUnixTimestamp(beforeDate);
    let deletedCount = 0;

    try {
      // Scan for items before date
      const scanCommand = new ScanCommand({
        TableName: tableName,
        FilterExpression: "timestamp < :beforeDate",
        ExpressionAttributeValues: {
          ":beforeDate": { N: beforeTs!.toString() },
        },
        ProjectionExpression: "partitionKey,sortKey",
      });

      let lastEvaluatedKey;
      do {
        const result = await this.client.send(
          new ScanCommand({
            ...scanCommand.input,
            ExclusiveStartKey: lastEvaluatedKey,
          })
        );

        // Delete items
        if (result.Items) {
          for (const item of result.Items) {
            await this.client.send(
              new DeleteItemCommand({
                TableName: tableName,
                Key: {
                  partitionKey: item.partitionKey,
                  sortKey: item.sortKey,
                },
              })
            );
            deletedCount++;
          }
        }

        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      logger.info("Deleted old events from DynamoDB", {
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
    if (!this.client) {
      throw new Error("Event log provider not connected");
    }

    const tableName = this.config.dynamodb!.tableName;

    try {
      const result = await this.client.send(
        new DescribeTableCommand({ TableName: tableName })
      );

      return {
        documentCount: result.Table?.ItemCount || 0,
        storageUsedMB: (result.Table?.TableSizeBytes || 0) / (1024 * 1024),
      };
    } catch (error) {
      logger.error("Failed to get storage stats", { error });
      return { documentCount: 0, storageUsedMB: 0 };
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.client) {
        return false;
      }

      const tableName = this.config.dynamodb!.tableName;
      await this.client.send(new DescribeTableCommand({ TableName: tableName }));
      return true;
    } catch (error) {
      logger.error("Event log provider health check failed", { error });
      return false;
    }
  }

  /**
   * Disconnect from DynamoDB
   */
  async disconnect(): Promise<void> {
    // Flush pending batch
    await this.flush();

    // Close client
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }

    logger.info("Disconnected from DynamoDB");
  }

  // ========================================================================
  // PRIVATE METHODS
  // ========================================================================

  /**
   * Ensure DynamoDB table exists with proper schema
   */
  private async ensureTable(): Promise<void> {
    if (!this.client) {
      throw new Error("Client not initialized");
    }

    const tableName = this.config.dynamodb!.tableName;

    try {
      // Try to describe table
      await this.client.send(new DescribeTableCommand({ TableName: tableName }));
      logger.debug("DynamoDB table exists", { tableName });
    } catch (error: any) {
      // Table doesn't exist, create it
      if (error.__type === "ResourceNotFoundException") {
        const billingMode = this.config.dynamodb!.billingMode || "PAY_PER_REQUEST";

        const createTableCommand = new CreateTableCommand({
          TableName: tableName,
          AttributeDefinitions: [
            { AttributeName: "partitionKey", AttributeType: "S" },
            { AttributeName: "sortKey", AttributeType: "S" },
            { AttributeName: "timestamp", AttributeType: "N" },
            { AttributeName: "userId", AttributeType: "S" },
            { AttributeName: "transactionId", AttributeType: "S" },
            { AttributeName: "correlationId", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "partitionKey", KeyType: "HASH" },
            { AttributeName: "sortKey", KeyType: "RANGE" },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: "timestampIndex",
              KeySchema: [{ AttributeName: "timestamp", KeyType: "HASH" }],
              Projection: { ProjectionType: "ALL" },
              ...(billingMode === "PROVISIONED" && {
                ProvisionedThroughput: {
                  ReadCapacityUnits: 100,
                  WriteCapacityUnits: 100,
                },
              }),
            },
            {
              IndexName: "userIdIndex",
              KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
              Projection: { ProjectionType: "ALL" },
              ...(billingMode === "PROVISIONED" && {
                ProvisionedThroughput: {
                  ReadCapacityUnits: 50,
                  WriteCapacityUnits: 50,
                },
              }),
            },
            {
              IndexName: "transactionIdIndex",
              KeySchema: [{ AttributeName: "transactionId", KeyType: "HASH" }],
              Projection: { ProjectionType: "ALL" },
              ...(billingMode === "PROVISIONED" && {
                ProvisionedThroughput: {
                  ReadCapacityUnits: 50,
                  WriteCapacityUnits: 50,
                },
              }),
            },
            {
              IndexName: "correlationIdIndex",
              KeySchema: [{ AttributeName: "correlationId", KeyType: "HASH" }],
              Projection: { ProjectionType: "ALL" },
              ...(billingMode === "PROVISIONED" && {
                ProvisionedThroughput: {
                  ReadCapacityUnits: 50,
                  WriteCapacityUnits: 50,
                },
              }),
            },
          ],
          BillingMode: billingMode,
          ...(billingMode === "PROVISIONED" && {
            ProvisionedThroughput: {
              ReadCapacityUnits:
                this.config.dynamodb?.provisionedThroughput?.readCapacityUnits ||
                100,
              WriteCapacityUnits:
                this.config.dynamodb?.provisionedThroughput
                  ?.writeCapacityUnits || 100,
            },
          }),
          StreamSpecification: {
            StreamViewType: "NEW_AND_OLD_IMAGES",
          },
          TimeToLiveSpecification: {
            AttributeName: "ttl",
            Enabled: true,
          },
          Tags: [
            { Key: "Service", Value: "ProxyPay" },
            { Key: "Component", Value: "EventLog" },
          ],
        });

        await this.client.send(createTableCommand);
        logger.info("Created DynamoDB table", { tableName });

        // Wait for table to be active
        await this.waitForTableActive(tableName);
      } else {
        throw error;
      }
    }
  }

  /**
   * Wait for DynamoDB table to become active
   */
  private async waitForTableActive(tableName: string): Promise<void> {
    if (!this.client) {
      throw new Error("Client not initialized");
    }

    const maxAttempts = 60;
    const delayMs = 1000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.client.send(
        new DescribeTableCommand({ TableName: tableName })
      );

      if (result.Table?.TableStatus === "ACTIVE") {
        logger.debug("DynamoDB table is active", { tableName });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(`DynamoDB table ${tableName} did not become active`);
  }

  /**
   * Put single item
   */
  private async putItem(event: Event): Promise<void> {
    if (!this.client) {
      throw new Error("Client not initialized");
    }

    const tableName = this.config.dynamodb!.tableName;

    await this.client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(event, { removeUndefinedValues: true }),
      })
    );
  }

  /**
   * Query by partition key
   */
  private async queryByPartition(
    params: EventQuery,
    tableName: string,
    limit: number
  ): Promise<EventQueryResponse> {
    if (!this.client) {
      throw new Error("Client not initialized");
    }

    const keyConditionExpression = "partitionKey = :pk";
    const expressionAttributeValues: Record<string, unknown> = {
      ":pk": params.partitionKey,
    };

    const command = new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: marshall(expressionAttributeValues),
      Limit: limit,
      ScanIndexForward: params.sortOrder === "asc",
    });

    const result = await this.client.send(command);
    const events = (result.Items || []).map((item) =>
      unmarshall(item)
    ) as Event[];

    return {
      events,
      count: events.length,
      hasMore: result.LastEvaluatedKey != null,
      query: params,
    };
  }

  /**
   * Scan events (flexible but less efficient)
   */
  private async scanEvents(
    params: EventQuery,
    tableName: string,
    limit: number
  ): Promise<EventQueryResponse> {
    if (!this.client) {
      throw new Error("Client not initialized");
    }

    const filterExpressions: string[] = [];
    const expressionAttributeValues: Record<string, unknown> = {};
    let counter = 0;

    if (params.userId) {
      filterExpressions.push(`userId = :userId`);
      expressionAttributeValues[":userId"] = params.userId;
    }

    if (params.transactionId) {
      filterExpressions.push(`transactionId = :transactionId`);
      expressionAttributeValues[":transactionId"] = params.transactionId;
    }

    if (params.correlationId) {
      filterExpressions.push(`correlationId = :correlationId`);
      expressionAttributeValues[":correlationId"] = params.correlationId;
    }

    if (params.startDate || params.endDate) {
      const startTs = this.toUnixTimestamp(params.startDate);
      const endTs = this.toUnixTimestamp(params.endDate);

      if (startTs) {
        filterExpressions.push(`timestamp >= :startTs`);
        expressionAttributeValues[":startTs"] = startTs;
      }
      if (endTs) {
        filterExpressions.push(`timestamp <= :endTs`);
        expressionAttributeValues[":endTs"] = endTs;
      }
    }

    const command = new ScanCommand({
      TableName: tableName,
      Limit: limit,
      ...(filterExpressions.length > 0 && {
        FilterExpression: filterExpressions.join(" AND "),
        ExpressionAttributeValues: marshall(expressionAttributeValues),
      }),
    });

    const result = await this.client.send(command);
    const events = (result.Items || []).map((item) =>
      unmarshall(item)
    ) as Event[];

    return {
      events,
      count: events.length,
      hasMore: result.LastEvaluatedKey != null,
      query: params,
    };
  }

  /**
   * Enrich event with required fields
   */
  private enrichEvent(event: Event): Event {
    const now = Date.now();
    const dateStr = new Date(now).toISOString().split("T")[0];

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
      ttl: Math.floor((event.ttl || 2592000) / 1000), // DynamoDB TTL is in seconds
    };
  }

  /**
   * Schedule batch flush
   */
  private scheduleFlush(): void {
    if (this.batchTimer) {
      return;
    }

    const batchInterval = this.config.batchIntervalMs || 5000;
    const batchSize = this.config.batchSize || 100;

    if (this.batch.length >= batchSize) {
      this.flush().catch((error) =>
        logger.error("Failed to flush batch", { error })
      );
      return;
    }

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
      const ms = Date.parse(date);
      if (!isNaN(ms)) {
        return ms;
      }
    }

    return null;
  }
}
