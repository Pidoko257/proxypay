import {
  executeWithCircuitBreakerEnhanced,
  getCircuitBreakerStatus,
  getProviderCircuitBreakerStatuses,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
  shutdownCircuitBreakers,
  isCircuitBreakerOpenError,
  CircuitBreakerConfig,
  CircuitBreakerStatus,
} from "../circuitBreakerEnhanced";

describe("Circuit Breaker Enhanced", () => {
  const defaultConfig: CircuitBreakerConfig = {
    timeoutMs: 5000,
    resetTimeoutMs: 30000,
    rollingCountTimeoutMs: 60000,
    rollingCountBuckets: 10,
    volumeThreshold: 3,
    errorThresholdPercentage: 50,
    capacity: 100,
  };

  afterEach(() => {
    shutdownCircuitBreakers();
  });

  describe("executeWithCircuitBreakerEnhanced", () => {
    it("should execute successful operations without opening circuit", async () => {
      const execute = jest.fn(async () => ({
        success: true,
        data: { transactionId: "123" },
      }));

      const result = await executeWithCircuitBreakerEnhanced(
        {
          provider: "mtn",
          operation: "sendPayout",
          execute,
        },
        defaultConfig
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ transactionId: "123" });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("should handle failed operations", async () => {
      const execute = jest.fn(async () => ({
        success: false,
        error: new Error("Connection timeout"),
      }));

      try {
        await executeWithCircuitBreakerEnhanced(
          {
            provider: "airtel",
            operation: "requestPayment",
            execute,
          },
          defaultConfig
        );
        fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Connection timeout");
        expect(execute).toHaveBeenCalledTimes(1);
      }
    });

    it("should execute fallback when circuit is open", async () => {
      const execute = jest.fn(async () => ({
        success: false,
        error: new Error("Provider down"),
      }));

      const fallback = jest.fn(async () => ({
        success: true,
        data: { fallbackData: true },
        isFromFallback: true,
      }));

      const config: CircuitBreakerConfig = {
        ...defaultConfig,
        volumeThreshold: 1,
        errorThresholdPercentage: 50,
      };

      // Trigger failures to open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await executeWithCircuitBreakerEnhanced(
            {
              provider: "orange",
              operation: "sendPayout",
              execute,
              fallback,
            },
            config
          );
        } catch (e) {
          // Expected
        }
      }

      // Next call should use fallback
      const result = await executeWithCircuitBreakerEnhanced(
        {
          provider: "orange",
          operation: "sendPayout",
          execute,
          fallback,
        },
        config
      );

      expect(result.success).toBe(true);
      expect(result.isFromFallback).toBe(true);
    });

    it("should include duration in result", async () => {
      const execute = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { success: true };
      });

      const result = await executeWithCircuitBreakerEnhanced(
        {
          provider: "mtn",
          operation: "getBalance",
          execute,
        },
        defaultConfig
      );

      expect(result.durationMs).toBeGreaterThanOrEqual(50);
    });

    it("should timeout operations exceeding configured timeout", async () => {
      const execute = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        return { success: true };
      });

      const config: CircuitBreakerConfig = {
        ...defaultConfig,
        timeoutMs: 100,
      };

      try {
        await executeWithCircuitBreakerEnhanced(
          {
            provider: "mtn",
            operation: "sendPayout",
            execute,
          },
          config
        );
      } catch (error) {
        // Expected to timeout
      }
    });
  });

  describe("Circuit Breaker State Management", () => {
    it("should transition from closed to open on repeated failures", async () => {
      const execute = jest.fn(async () => ({
        success: false,
        error: new Error("Failure"),
      }));

      const config: CircuitBreakerConfig = {
        ...defaultConfig,
        volumeThreshold: 1,
      };

      // Initial state: closed
      let status = getCircuitBreakerStatus("provider1", "operation1");
      expect(status.state).toBe("closed");

      // Trigger failures
      for (let i = 0; i < 3; i++) {
        try {
          await executeWithCircuitBreakerEnhanced(
            {
              provider: "provider1",
              operation: "operation1",
              execute,
            },
            config
          );
        } catch (e) {
          // Expected
        }
      }

      // Circuit should be open
      status = getCircuitBreakerStatus("provider1", "operation1");
      expect(status.state).toBe("open");
      expect(status.consecutiveFailures).toBeGreaterThan(0);
    });

    it("should track success and failure counts", async () => {
      let callCount = 0;
      const execute = jest.fn(async () => {
        callCount++;
        return {
          success: callCount <= 2,
          error: callCount > 2 ? new Error("Failed") : undefined,
        };
      });

      // Successful calls
      await executeWithCircuitBreakerEnhanced(
        {
          provider: "test_provider",
          operation: "test_op",
          execute,
        },
        defaultConfig
      );

      await executeWithCircuitBreakerEnhanced(
        {
          provider: "test_provider",
          operation: "test_op",
          execute,
        },
        defaultConfig
      );

      const status = getCircuitBreakerStatus("test_provider", "test_op");
      expect(status.successCount).toBeGreaterThan(0);
    });
  });

  describe("getCircuitBreakerStatus", () => {
    it("should return status for a specific circuit breaker", async () => {
      const execute = jest.fn(async () => ({ success: true }));

      await executeWithCircuitBreakerEnhanced(
        {
          provider: "mtn",
          operation: "sendPayout",
          execute,
        },
        defaultConfig
      );

      const status = getCircuitBreakerStatus("mtn", "sendPayout");

      expect(status).toEqual(
        expect.objectContaining({
          provider: "mtn",
          operation: "sendPayout",
          state: "closed",
          successCount: 1,
        })
      );
    });

    it("should return default status for non-existent circuit breaker", () => {
      const status = getCircuitBreakerStatus("unknown", "unknown");

      expect(status.state).toBe("closed");
      expect(status.successCount).toBe(0);
    });
  });

  describe("getProviderCircuitBreakerStatuses", () => {
    it("should return statuses for all operations of a provider", async () => {
      const execute = jest.fn(async () => ({ success: true }));

      // Create multiple circuit breakers for same provider
      await executeWithCircuitBreakerEnhanced(
        {
          provider: "mtn",
          operation: "sendPayout",
          execute,
        },
        defaultConfig
      );

      await executeWithCircuitBreakerEnhanced(
        {
          provider: "mtn",
          operation: "requestPayment",
          execute,
        },
        defaultConfig
      );

      const statuses = getProviderCircuitBreakerStatuses("mtn");

      expect(statuses.length).toBeGreaterThanOrEqual(2);
      expect(statuses.map((s) => s.operation)).toContain("sendpayout");
      expect(statuses.map((s) => s.operation)).toContain("requestpayment");
    });
  });

  describe("resetCircuitBreaker", () => {
    it("should reset a specific circuit breaker", async () => {
      const execute = jest.fn(async () => ({
        success: false,
        error: new Error("Failed"),
      }));

      const config: CircuitBreakerConfig = {
        ...defaultConfig,
        volumeThreshold: 1,
      };

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await executeWithCircuitBreakerEnhanced(
            {
              provider: "mtn",
              operation: "sendPayout",
              execute,
            },
            config
          );
        } catch (e) {
          // Expected
        }
      }

      let status = getCircuitBreakerStatus("mtn", "sendPayout");
      expect(status.state).toBe("open");

      // Reset the circuit
      resetCircuitBreaker("mtn", "sendPayout");

      status = getCircuitBreakerStatus("mtn", "sendPayout");
      expect(status.state).toBe("closed");
    });
  });

  describe("resetAllCircuitBreakers", () => {
    it("should reset all circuit breakers for a provider", async () => {
      const execute = jest.fn(async () => ({
        success: false,
        error: new Error("Failed"),
      }));

      const config: CircuitBreakerConfig = {
        ...defaultConfig,
        volumeThreshold: 1,
      };

      // Open circuits for multiple operations
      const operations = ["sendPayout", "requestPayment", "getBalance"];

      for (const op of operations) {
        for (let i = 0; i < 3; i++) {
          try {
            await executeWithCircuitBreakerEnhanced(
              {
                provider: "mtn",
                operation: op,
                execute,
              },
              config
            );
          } catch (e) {
            // Expected
          }
        }
      }

      // Verify circuits are open
      for (const op of operations) {
        const status = getCircuitBreakerStatus("mtn", op);
        expect(status.state).toBe("open");
      }

      // Reset all for the provider
      resetAllCircuitBreakers("mtn");

      // Verify all are closed
      for (const op of operations) {
        const status = getCircuitBreakerStatus("mtn", op);
        expect(status.state).toBe("closed");
      }
    });
  });

  describe("isCircuitBreakerOpenError", () => {
    it("should identify circuit breaker open errors", () => {
      const error = new Error("Circuit breaker is open");
      (error as any).code = "EOPENBREAKER";

      expect(isCircuitBreakerOpenError(error)).toBe(true);
    });

    it("should return false for non-circuit breaker errors", () => {
      const error = new Error("Some other error");
      expect(isCircuitBreakerOpenError(error)).toBe(false);
      expect(isCircuitBreakerOpenError("not an error")).toBe(false);
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle concurrent operations safely", async () => {
      const execute = jest.fn(async () => ({
        success: true,
        data: { id: Math.random() },
      }));

      const promises = Array.from({ length: 10 }, (_, i) =>
        executeWithCircuitBreakerEnhanced(
          {
            provider: "concurrent_test",
            operation: "operation",
            execute,
          },
          defaultConfig
        )
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      expect(results.every((r) => r.success)).toBe(true);
      expect(execute).toHaveBeenCalledTimes(10);
    });

    it("should handle concurrent failures safely", async () => {
      const execute = jest.fn(async () => ({
        success: false,
        error: new Error("Failed"),
      }));

      const config: CircuitBreakerConfig = {
        ...defaultConfig,
        volumeThreshold: 1,
      };

      const promises = Array.from({ length: 5 }, () =>
        executeWithCircuitBreakerEnhanced(
          {
            provider: "concurrent_fail_test",
            operation: "operation",
            execute,
          },
          config
        ).catch(() => null)
      );

      await Promise.all(promises);

      // Circuit should be open after concurrent failures
      const status = getCircuitBreakerStatus(
        "concurrent_fail_test",
        "operation"
      );
      expect(status.state).toBe("open");
    });
  });

  describe("Integration with Mobile Money Scenario", () => {
    it("should failover to backup provider when primary circuit opens", async () => {
      let primaryCallCount = 0;
      const primaryExecute = jest.fn(async () => {
        primaryCallCount++;
        return {
          success: primaryCallCount <= 2,
          error: primaryCallCount > 2 ? new Error("Primary down") : undefined,
        };
      });

      const fallback = jest.fn(async () => ({
        success: true,
        data: { provider: "backup", amount: 1000 },
        isFromFallback: true,
      }));

      const config: CircuitBreakerConfig = {
        ...defaultConfig,
        volumeThreshold: 1,
      };

      // Make successful calls
      for (let i = 0; i < 2; i++) {
        await executeWithCircuitBreakerEnhanced(
          {
            provider: "mtn",
            operation: "sendPayout",
            execute: primaryExecute,
          },
          config
        );
      }

      // Make failed calls to open circuit
      for (let i = 0; i < 2; i++) {
        try {
          await executeWithCircuitBreakerEnhanced(
            {
              provider: "mtn",
              operation: "sendPayout",
              execute: primaryExecute,
              fallback,
            },
            config
          );
        } catch (e) {
          // Expected on first attempt
        }
      }

      // Next call should use fallback
      const result = await executeWithCircuitBreakerEnhanced(
        {
          provider: "mtn",
          operation: "sendPayout",
          execute: primaryExecute,
          fallback,
        },
        config
      );

      expect(result.success).toBe(true);
      expect(result.isFromFallback).toBe(true);
    });
  });
});
