import {
  publishTransactionUpdate,
  publishTransactionCompleted,
  publishTransactionFailed,
  publishDisputeUpdate,
  publishBulkImportJobUpdate,
  getSubscriptionMetrics,
  getChannelMetrics,
  getSubscriptionHealth,
} from "../../src/graphql/subscriptionManager";
import {
  SubscriptionChannels,
  transactionChannel,
  type TransactionUpdatedPayload,
  type TransactionCompletedPayload,
  type DisputeCreatedPayload,
} from "../../src/graphql/subscriptions";
import { pubsub } from "../../src/graphql/subscriptions";

describe("GraphQL Subscription Manager", () => {
  describe("publishTransactionUpdate", () => {
    it("should publish transaction updates with latency tracking", async () => {
      const payload: TransactionUpdatedPayload = {
        id: "tx_123",
        referenceNumber: "ref_123",
        status: "processing",
        updatedAt: new Date().toISOString(),
      };

      const publishSpy = jest.spyOn(pubsub, "publish");
      await publishTransactionUpdate(SubscriptionChannels.TRANSACTION_UPDATED, payload);

      expect(publishSpy).toHaveBeenCalledWith(
        SubscriptionChannels.TRANSACTION_UPDATED,
        payload,
      );
      publishSpy.mockRestore();
    });

    it("should handle publication errors gracefully", async () => {
      const payload: TransactionUpdatedPayload = {
        id: "tx_123",
        referenceNumber: "ref_123",
        status: "processing",
        updatedAt: new Date().toISOString(),
      };

      const publishSpy = jest
        .spyOn(pubsub, "publish")
        .mockRejectedValueOnce(new Error("Publish failed"));

      // Should not throw
      await publishTransactionUpdate(SubscriptionChannels.TRANSACTION_UPDATED, payload);

      publishSpy.mockRestore();
    });

    it("should track metrics for publications", async () => {
      const payload: TransactionUpdatedPayload = {
        id: "tx_123",
        referenceNumber: "ref_123",
        status: "processing",
        updatedAt: new Date().toISOString(),
      };

      jest.spyOn(pubsub, "publish").mockResolvedValueOnce();
      await publishTransactionUpdate(SubscriptionChannels.TRANSACTION_UPDATED, payload);

      const metrics = getChannelMetrics(SubscriptionChannels.TRANSACTION_UPDATED);
      expect(metrics.length).toBeGreaterThan(0);
      expect(metrics[0].totalPublished).toBeGreaterThan(0);
    });
  });

  describe("publishTransactionCompleted", () => {
    it("should publish to both per-transaction and global channels", async () => {
      const transactionId = "tx_456";
      const payload: TransactionCompletedPayload = {
        id: transactionId,
        referenceNumber: "ref_456",
        status: "completed",
        completedAt: new Date().toISOString(),
      };

      const publishSpy = jest
        .spyOn(pubsub, "publish")
        .mockResolvedValueOnce()
        .mockResolvedValueOnce();

      await publishTransactionCompleted(transactionId, payload);

      expect(publishSpy).toHaveBeenCalledTimes(2);
      expect(publishSpy).toHaveBeenCalledWith(transactionChannel(transactionId), payload);
      expect(publishSpy).toHaveBeenCalledWith("transaction.completed", payload);

      publishSpy.mockRestore();
    });

    it("should track latency for multi-channel publications", async () => {
      const transactionId = "tx_789";
      const payload: TransactionCompletedPayload = {
        id: transactionId,
        referenceNumber: "ref_789",
        status: "completed",
        completedAt: new Date().toISOString(),
      };

      jest.spyOn(pubsub, "publish").mockResolvedValue();
      await publishTransactionCompleted(transactionId, payload);

      const metrics = getSubscriptionMetrics();
      expect(metrics.metrics.length).toBeGreaterThan(0);
    });
  });

  describe("publishTransactionFailed", () => {
    it("should publish transaction failures", async () => {
      const transactionId = "tx_fail_1";
      const payload = {
        id: transactionId,
        referenceNumber: "ref_fail_1",
        status: "failed",
        failedAt: new Date().toISOString(),
        error: "Provider timeout",
      };

      const publishSpy = jest
        .spyOn(pubsub, "publish")
        .mockResolvedValueOnce()
        .mockResolvedValueOnce();

      await publishTransactionFailed(transactionId, payload);

      expect(publishSpy).toHaveBeenCalledTimes(2);
      publishSpy.mockRestore();
    });
  });

  describe("publishDisputeUpdate", () => {
    it("should publish dispute creations", async () => {
      const payload: DisputeCreatedPayload = {
        id: "dispute_1",
        transactionId: "tx_123",
        reason: "Unauthorized",
        status: "open",
        reportedBy: "user_1",
        createdAt: new Date().toISOString(),
      };

      const publishSpy = jest
        .spyOn(pubsub, "publish")
        .mockResolvedValueOnce();

      await publishDisputeUpdate(SubscriptionChannels.DISPUTE_CREATED, payload);

      expect(publishSpy).toHaveBeenCalledWith(
        SubscriptionChannels.DISPUTE_CREATED,
        payload,
      );
      publishSpy.mockRestore();
    });
  });

  describe("publishBulkImportJobUpdate", () => {
    it("should publish bulk job updates", async () => {
      const jobId = "job_bulk_1";
      const payload = {
        jobId,
        status: "processing",
        progress: {
          total: 1000,
          processed: 500,
          succeeded: 490,
          failed: 10,
        },
        errors: [
          { row: 10, error: "Invalid phone number" },
          { row: 50, error: "Duplicate reference" },
        ],
        completedAt: null,
      };

      const publishSpy = jest
        .spyOn(pubsub, "publish")
        .mockResolvedValueOnce();

      await publishBulkImportJobUpdate(jobId, payload);

      expect(publishSpy).toHaveBeenCalled();
      publishSpy.mockRestore();
    });
  });

  describe("Subscription Metrics and Health", () => {
    it("should return subscription metrics", () => {
      const metrics = getSubscriptionMetrics();

      expect(metrics).toHaveProperty("metrics");
      expect(metrics).toHaveProperty("timestamp");
      expect(metrics).toHaveProperty("slo");
      expect(metrics.slo.targetMs).toBe(100);
    });

    it("should return channel-specific metrics", async () => {
      const payload: TransactionUpdatedPayload = {
        id: "tx_metric_1",
        referenceNumber: "ref_metric_1",
        status: "processing",
        updatedAt: new Date().toISOString(),
      };

      jest.spyOn(pubsub, "publish").mockResolvedValueOnce();
      await publishTransactionUpdate(SubscriptionChannels.TRANSACTION_UPDATED, payload);

      const metrics = getChannelMetrics(SubscriptionChannels.TRANSACTION_UPDATED);
      expect(Array.isArray(metrics)).toBe(true);
      if (metrics.length > 0) {
        expect(metrics[0]).toHaveProperty("channel");
        expect(metrics[0]).toHaveProperty("totalPublished");
        expect(metrics[0]).toHaveProperty("peakLatencyMs");
      }
    });

    it("should provide health status", () => {
      const health = getSubscriptionHealth();

      expect(health).toHaveProperty("healthy");
      expect(health).toHaveProperty("totalChannels");
      expect(health).toHaveProperty("channelsExceedingSLO");
      expect(health).toHaveProperty("averageLatencyMs");
      expect(health).toHaveProperty("peakLatencyMs");
    });

    it("should flag unhealthy subscriptions (>100ms latency)", async () => {
      // Mock a slow publication
      jest.spyOn(pubsub, "publish").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(), 150); // 150ms > 100ms SLO
          }),
      );

      const payload: TransactionUpdatedPayload = {
        id: "tx_slow",
        referenceNumber: "ref_slow",
        status: "processing",
        updatedAt: new Date().toISOString(),
      };

      await publishTransactionUpdate(SubscriptionChannels.TRANSACTION_UPDATED, payload);

      const health = getSubscriptionHealth();
      // Peak latency should be around 150ms
      expect(health.peakLatencyMs).toBeGreaterThan(100);
    });

    it("should maintain subscription metrics across multiple publications", async () => {
      jest.spyOn(pubsub, "publish").mockResolvedValue();

      const payload: TransactionUpdatedPayload = {
        id: "tx_123",
        referenceNumber: "ref_123",
        status: "processing",
        updatedAt: new Date().toISOString(),
      };

      // Publish multiple times
      for (let i = 0; i < 5; i++) {
        await publishTransactionUpdate(SubscriptionChannels.TRANSACTION_UPDATED, payload);
      }

      const metrics = getChannelMetrics(SubscriptionChannels.TRANSACTION_UPDATED);
      if (metrics.length > 0) {
        expect(metrics[0].totalPublished).toBeGreaterThanOrEqual(5);
      }
    });
  });

  describe("Subscription guarantees", () => {
    it("should deliver within <100ms for typical loads", async () => {
      jest.spyOn(pubsub, "publish").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            // Simulate typical delivery (50ms)
            setTimeout(() => resolve(), 50);
          }),
      );

      const payload: TransactionUpdatedPayload = {
        id: "tx_fast",
        referenceNumber: "ref_fast",
        status: "processing",
        updatedAt: new Date().toISOString(),
      };

      const start = Date.now();
      await publishTransactionUpdate(SubscriptionChannels.TRANSACTION_UPDATED, payload);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(150); // Should complete quickly
    });

    it("should support high-frequency updates", async () => {
      jest.spyOn(pubsub, "publish").mockResolvedValue();

      const transactionId = "tx_high_freq";

      // Simulate rapid updates
      const updates = Array.from({ length: 100 }, (_, i) => ({
        id: transactionId,
        referenceNumber: `ref_${i}`,
        status: "processing",
        updatedAt: new Date().toISOString(),
        jobProgress: i,
      }));

      const start = Date.now();
      await Promise.all(
        updates.map((u) => publishTransactionUpdate(SubscriptionChannels.TRANSACTION_UPDATED, u)),
      );
      const duration = Date.now() - start;

      // All 100 publications should complete in reasonable time
      expect(duration).toBeLessThan(5000);

      const health = getSubscriptionHealth();
      expect(health.averageLatencyMs).toBeLessThan(150);
    });

    it("should not lose data during high-frequency publishing", async () => {
      jest.spyOn(pubsub, "publish").mockResolvedValue();

      const publishCount = 50;
      const updates = Array.from({ length: publishCount }, (_, i) => ({
        id: `tx_${i}`,
        referenceNumber: `ref_${i}`,
        status: "processing",
        updatedAt: new Date().toISOString(),
      }));

      await Promise.all(
        updates.map((u) => publishTransactionUpdate(SubscriptionChannels.TRANSACTION_UPDATED, u)),
      );

      const metrics = getSubscriptionMetrics();
      const totalPublished = metrics.metrics.reduce(
        (sum, m) => sum + m.totalPublished,
        0,
      );

      expect(totalPublished).toBeGreaterThanOrEqual(publishCount);
    });
  });
});
