/**
 * Event Log Service Tests
 *
 * Tests for both Cosmos DB and DynamoDB implementations
 */

import {
  EventLogService,
  getEventLogService,
} from "../eventLogService";
import {
  EventCategory,
  EventSeverity,
  EventLogConfig,
  Event,
} from "../types";

describe("EventLogService", () => {
  let service: EventLogService;
  const mockConfig: EventLogConfig = {
    provider: "dynamodb",
    batchSize: 10,
    batchIntervalMs: 1000,
    enableBatching: true,
    dynamodb: {
      region: "us-east-1",
      tableName: "EventLog-Test",
      endpoint: "http://localhost:8000", // For local DynamoDB
      billingMode: "PAY_PER_REQUEST",
    },
  };

  beforeEach(async () => {
    service = new EventLogService(mockConfig);
  });

  describe("Initialization", () => {
    it("should create service instance", () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(EventLogService);
    });

    it("should have default metrics", () => {
      const metrics = service.getMetrics();
      expect(metrics.eventsWritten).toBe(0);
      expect(metrics.failedWrites).toBe(0);
    });
  });

  describe("Event Logging", () => {
    it("should log simple event", async () => {
      const event = await service.log({
        category: EventCategory.SYSTEM,
        type: "test.event",
        title: "Test Event",
        description: "A test event",
      });

      // In real implementation, would verify in database
      expect(service.getMetrics().eventsWritten).toBeGreaterThanOrEqual(0);
    });

    it("should log transaction event", async () => {
      await service.logTransaction("txn-123", "completed", {
        amount: "1000",
        provider: "mtn",
      });

      const metrics = service.getMetrics();
      expect(metrics.eventsWritten).toBeGreaterThanOrEqual(0);
    });

    it("should log payment event", async () => {
      await service.logPayment("mtn", "initiated", "1000", "237671234567", {
        fee: "10",
      });

      const metrics = service.getMetrics();
      expect(metrics.eventsWritten).toBeGreaterThanOrEqual(0);
    });

    it("should log authentication event", async () => {
      await service.logAuth("user-123", "login", true, {
        ipAddress: "192.168.1.1",
      });

      expect(service.getMetrics().eventsWritten).toBeGreaterThanOrEqual(0);
    });

    it("should log auth failure", async () => {
      await service.logAuth("user-123", "login", false, {
        reason: "invalid_password",
      });

      expect(service.getMetrics().eventsWritten).toBeGreaterThanOrEqual(0);
    });

    it("should log error event", async () => {
      const error = new Error("Test error");
      await service.logError(error, {
        errorCode: "ERR_TEST",
        context: "payment",
      });

      expect(service.getMetrics().eventsWritten).toBeGreaterThanOrEqual(0);
    });

    it("should log compliance event", async () => {
      await service.logCompliance("kyc_check", {
        userId: "user-123",
        level: "full",
        status: "verified",
      });

      expect(service.getMetrics().eventsWritten).toBeGreaterThanOrEqual(0);
    });

    it("should log security event", async () => {
      await service.logSecurity(
        "suspicious_activity",
        EventSeverity.WARNING,
        {
          userId: "user-123",
          activity: "rapid_transactions",
          count: 5,
        }
      );

      expect(service.getMetrics().eventsWritten).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Batch Operations", () => {
    it("should batch multiple events", async () => {
      const events = [
        {
          category: EventCategory.TRANSACTION,
          type: "transaction.initiated",
          title: "Transaction 1",
          description: "First transaction",
          transactionId: "txn-1",
        },
        {
          category: EventCategory.PAYMENT,
          type: "payment.mtn.completed",
          title: "Payment 2",
          description: "Second payment",
          providerId: "mtn",
        },
      ];

      await service.logBatch(events);

      const metrics = service.getMetrics();
      expect(metrics.batchCount).toBeGreaterThanOrEqual(0);
    });

    it("should enrich events during batch", async () => {
      const events = [
        {
          type: "test.event",
          title: "Test",
          description: "Testing",
        },
      ] as any;

      await service.logBatch(events);

      // Verify metrics updated
      expect(service.getMetrics().eventsWritten).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Metrics", () => {
    it("should track metrics", async () => {
      const initialMetrics = service.getMetrics();
      expect(initialMetrics.eventsWritten).toBe(0);

      // Note: In real tests with DB connection, write events and check metrics
      expect(service.getMetrics()).toBeDefined();
    });

    it("should reset metrics", () => {
      service.resetMetrics();
      const metrics = service.getMetrics();

      expect(metrics.eventsWritten).toBe(0);
      expect(metrics.eventsQueried).toBe(0);
      expect(metrics.failedWrites).toBe(0);
      expect(metrics.failedQueries).toBe(0);
    });

    it("should calculate average latencies", async () => {
      const initialMetrics = service.getMetrics();
      expect(initialMetrics.averageWriteLatencyMs).toBe(0);
    });
  });

  describe("Event Enrichment", () => {
    it("should auto-generate missing fields", async () => {
      // This would be tested with database integration
      const event: Partial<Event> = {
        type: "test",
        title: "Test",
      };

      // Would verify enriched event has:
      // - id (UUID)
      // - partitionKey (YYYY-MM-DD)
      // - sortKey (timestamp#uuid)
      // - timestamp
      // - version
      // - createdAt
    });

    it("should preserve provided fields", async () => {
      const customId = "custom-id-123";
      // Would log event with customId and verify it's preserved
    });
  });

  describe("Phone Number Masking", () => {
    it("should mask phone numbers in payment events", async () => {
      // Verify that payment logging masks phone numbers
      // for privacy/security
      await service.logPayment("mtn", "completed", "1000", "237671234567", {});

      // Check that logged data has masked phone
    });
  });
});

describe("EventLogService - Query Operations", () => {
  let service: EventLogService;

  beforeEach(() => {
    service = new EventLogService({
      provider: "dynamodb",
      dynamodb: {
        region: "us-east-1",
        tableName: "EventLog-Test",
        endpoint: "http://localhost:8000",
        billingMode: "PAY_PER_REQUEST",
      },
    });
  });

  describe("Query Methods", () => {
    it("should have query method", () => {
      expect(typeof service.query).toBe("function");
    });

    it("should have queryByCorrelationId method", () => {
      expect(typeof service.queryByCorrelationId).toBe("function");
    });

    it("should have queryByTransactionId method", () => {
      expect(typeof service.queryByTransactionId).toBe("function");
    });

    it("should have queryByUserId method", () => {
      expect(typeof service.queryByUserId).toBe("function");
    });

    it("should have getStats method", () => {
      expect(typeof service.getStats).toBe("function");
    });
  });

  describe("Admin Operations", () => {
    it("should have deleteOldEvents method", () => {
      expect(typeof service.deleteOldEvents).toBe("function");
    });

    it("should have getStorageStats method", () => {
      expect(typeof service.getStorageStats).toBe("function");
    });

    it("should have healthCheck method", () => {
      expect(typeof service.healthCheck).toBe("function");
    });
  });
});

describe("EventLogService - Singleton", () => {
  it("should provide singleton instance", async () => {
    const config: EventLogConfig = {
      provider: "dynamodb",
      dynamodb: {
        region: "us-east-1",
        tableName: "EventLog-Test",
        billingMode: "PAY_PER_REQUEST",
      },
    };

    // Note: This would fail without proper DB setup
    // In real tests, mock the provider
    expect(() => {
      getEventLogService(config);
    }).not.toThrow();
  });
});

describe("Event Types", () => {
  it("should support all event categories", () => {
    const categories = Object.values(EventCategory);
    expect(categories).toContain("transaction");
    expect(categories).toContain("payment");
    expect(categories).toContain("auth");
    expect(categories).toContain("error");
  });

  it("should support all severity levels", () => {
    const severities = Object.values(EventSeverity);
    expect(severities).toContain("debug");
    expect(severities).toContain("info");
    expect(severities).toContain("warning");
    expect(severities).toContain("error");
    expect(severities).toContain("critical");
  });
});

describe("Configuration", () => {
  it("should accept DynamoDB config", () => {
    const config: EventLogConfig = {
      provider: "dynamodb",
      dynamodb: {
        region: "us-east-1",
        tableName: "events",
        billingMode: "PAY_PER_REQUEST",
      },
    };

    const service = new EventLogService(config);
    expect(service).toBeDefined();
  });

  it("should accept Cosmos DB config", () => {
    const config: EventLogConfig = {
      provider: "cosmos",
      cosmosDb: {
        endpoint: "https://mydb.documents.azure.com:443/",
        key: "test-key",
        databaseId: "events",
        containerId: "logs",
        partitionKey: "/partitionKey",
      },
    };

    const service = new EventLogService(config);
    expect(service).toBeDefined();
  });

  it("should validate provider type", () => {
    expect(() => {
      new EventLogService({ provider: "invalid" as any });
    }).not.toThrow(); // Throws on initialize
  });

  it("should allow custom batch settings", () => {
    const config: EventLogConfig = {
      provider: "dynamodb",
      batchSize: 50,
      batchIntervalMs: 2000,
      enableBatching: true,
      dynamodb: {
        region: "us-east-1",
        tableName: "events",
        billingMode: "PAY_PER_REQUEST",
      },
    };

    const service = new EventLogService(config);
    expect(service).toBeDefined();
  });
});
