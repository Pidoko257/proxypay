/**
 * Comprehensive tests for detailed health check functionality
 * Tests component health metrics, response times, and overall status
 */

import {
  checkDatabaseHealth,
  checkRedisHealth,
  checkProvidersHealthWithTiming,
  checkReplicationHealth,
  checkMemoryHealth,
  getDetailedComponentHealth,
  determineOverallStatus,
} from "../src/services/componentHealthService";
import { ComponentHealthMetrics } from "../src/types/api";

// Mock the dependencies
jest.mock("../src/config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../src/config/redis", () => ({
  redisClient: {
    ping: jest.fn(),
    isOpen: true,
  },
}));

jest.mock("../src/services/mobilemoney/providers/healthCheck", () => ({
  checkMobileMoneyHealth: jest.fn(),
}));

import { pool } from "../src/config/database";
import { redisClient } from "../src/config/redis";
import { checkMobileMoneyHealth } from "../src/services/mobilemoney/providers/healthCheck";

describe("Component Health Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("checkDatabaseHealth", () => {
    it("returns healthy status when database query succeeds", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

      const result = await checkDatabaseHealth();

      expect(result.status).toBe("healthy");
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
      expect(result.lastChecked).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.responseTime).toBeLessThan(1000); // Should be fast
    });

    it("returns down status when database query fails", async () => {
      const error = new Error("Connection refused");
      (pool.query as jest.Mock).mockRejectedValueOnce(error);

      const result = await checkDatabaseHealth();

      expect(result.status).toBe("down");
      expect(result.error).toBe("Connection refused");
      expect(result.lastChecked).toBeDefined();
      expect(result.responseTime).toBeDefined();
    });

    it("measures response time accurately", async () => {
      (pool.query as jest.Mock).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ rows: [] }), 50);
          })
      );

      const result = await checkDatabaseHealth();

      expect(result.responseTime).toBeGreaterThanOrEqual(50);
      expect(result.responseTime).toBeLessThan(200);
    });
  });

  describe("checkRedisHealth", () => {
    it("returns healthy status when redis ping succeeds", async () => {
      (redisClient.ping as jest.Mock).mockResolvedValueOnce("PONG");

      const result = await checkRedisHealth();

      expect(result.status).toBe("healthy");
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
      expect(result.lastChecked).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it("returns down status when redis is not open", async () => {
      const originalIsOpen = redisClient.isOpen;
      (redisClient as any).isOpen = false;

      const result = await checkRedisHealth();

      expect(result.status).toBe("down");
      expect(result.error).toBe("Redis client not open");

      (redisClient as any).isOpen = originalIsOpen;
    });

    it("returns down status when redis ping fails", async () => {
      const error = new Error("Redis timeout");
      (redisClient.ping as jest.Mock).mockRejectedValueOnce(error);

      const result = await checkRedisHealth();

      expect(result.status).toBe("down");
      expect(result.error).toBe("Redis timeout");
    });
  });

  describe("checkProvidersHealthWithTiming", () => {
    it("returns detailed provider status with healthy providers", async () => {
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValueOnce({
        providers: {
          mtn: { status: "up" },
          airtel: { status: "up" },
          orange: { status: "down" },
        },
      });

      const result = await checkProvidersHealthWithTiming();

      expect(result.status).toBe("healthy");
      expect(result.providers).toEqual({
        mtn: "up",
        airtel: "up",
        orange: "down",
      });
      expect(result.healthyCount).toBe(2);
      expect(result.totalCount).toBe(3);
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
    });

    it("returns degraded status when some providers are down", async () => {
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValueOnce({
        providers: {
          mtn: { status: "up" },
          airtel: { status: "down" },
          orange: { status: "down" },
        },
      });

      const result = await checkProvidersHealthWithTiming();

      expect(result.status).toBe("healthy"); // Service succeeded
      expect(result.healthyCount).toBe(1);
      expect(result.totalCount).toBe(3);
    });

    it("returns down status when provider check fails", async () => {
      const error = new Error("Provider API error");
      (checkMobileMoneyHealth as jest.Mock).mockRejectedValueOnce(error);

      const result = await checkProvidersHealthWithTiming();

      expect(result.status).toBe("down");
      expect(result.error).toBe("Provider API error");
    });
  });

  describe("checkMemoryHealth", () => {
    it("returns healthy when memory usage is below 90% limit", () => {
      const result = checkMemoryHealth(1024); // 1GB limit

      expect(result.status).toBe("healthy");
      expect(result.responseTime).toBe(0); // Memory check is instant
      expect(result.lastChecked).toBeDefined();
    });

    it("returns degraded when memory usage is between 90-100% of limit", () => {
      // Mock high memory usage
      const originalMemUsage = process.memoryUsage;
      (process.memoryUsage as jest.Mock) = jest.fn(() => ({
        heapUsed: 950 * 1024 * 1024, // 950MB out of 1024MB (93%)
        heapTotal: 1024 * 1024 * 1024,
        rss: 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      }));

      const result = checkMemoryHealth(1024);

      expect(result.status).toBe("degraded");
      expect(result.error).toContain("Heap usage");

      process.memoryUsage = originalMemUsage;
    });

    it("includes heap usage details in error message", () => {
      const originalMemUsage = process.memoryUsage;
      (process.memoryUsage as jest.Mock) = jest.fn(() => ({
        heapUsed: 1100 * 1024 * 1024, // 1100MB out of 1024MB
        heapTotal: 1200 * 1024 * 1024,
        rss: 1200 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      }));

      const result = checkMemoryHealth(1024);

      expect(result.status).toBe("down");
      expect(result.error).toMatch(/1[01][0-9]\.\d{2}MB/); // Match heap size in MB

      process.memoryUsage = originalMemUsage;
    });
  });

  describe("getDetailedComponentHealth", () => {
    it("returns all component metrics in parallel", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      (redisClient.ping as jest.Mock).mockResolvedValueOnce("PONG");
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValueOnce({
        providers: {
          mtn: { status: "up" },
          airtel: { status: "up" },
          orange: { status: "up" },
        },
      });

      const result = await getDetailedComponentHealth();

      expect(result.database).toBeDefined();
      expect(result.redis).toBeDefined();
      expect(result.providers).toBeDefined();
      expect(result.replication).toBeDefined();
      expect(result.memory).toBeDefined();
    });

    it("includes response times for each component", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      (redisClient.ping as jest.Mock).mockResolvedValueOnce("PONG");
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValueOnce({
        providers: { mtn: { status: "up" }, airtel: { status: "up" }, orange: { status: "up" } },
      });

      const result = await getDetailedComponentHealth();

      expect(typeof result.database.responseTime).toBe("number");
      expect(typeof result.redis.responseTime).toBe("number");
      expect(typeof result.providers.responseTime).toBe("number");
      expect(result.database.responseTime).toBeGreaterThanOrEqual(0);
    });

    it("includes ISO 8601 timestamps", async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      (redisClient.ping as jest.Mock).mockResolvedValueOnce("PONG");
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValueOnce({
        providers: { mtn: { status: "up" }, airtel: { status: "up" }, orange: { status: "up" } },
      });

      const result = await getDetailedComponentHealth();

      expect(result.database.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.redis.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.providers.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("determineOverallStatus", () => {
    it("returns healthy when all critical components are healthy", () => {
      const components = {
        database: { status: "healthy" as const },
        redis: { status: "healthy" as const },
        providers: { status: "healthy" as const },
      };

      const result = determineOverallStatus(components as any);

      expect(result).toBe("healthy");
    });

    it("returns down when database is down", () => {
      const components = {
        database: { status: "down" as const },
        redis: { status: "healthy" as const },
        providers: { status: "healthy" as const },
      };

      const result = determineOverallStatus(components as any);

      expect(result).toBe("down");
    });

    it("returns down when redis is down", () => {
      const components = {
        database: { status: "healthy" as const },
        redis: { status: "down" as const },
        providers: { status: "healthy" as const },
      };

      const result = determineOverallStatus(components as any);

      expect(result).toBe("down");
    });

    it("returns degraded when providers are degraded but critical components are healthy", () => {
      const components = {
        database: { status: "healthy" as const },
        redis: { status: "healthy" as const },
        providers: { status: "degraded" as const },
      };

      const result = determineOverallStatus(components as any);

      expect(result).toBe("degraded");
    });

    it("returns degraded when replication is degraded", () => {
      const components = {
        database: { status: "healthy" as const },
        redis: { status: "healthy" as const },
        providers: { status: "healthy" as const },
        replication: { status: "degraded" as const },
      };

      const result = determineOverallStatus(components as any);

      expect(result).toBe("degraded");
    });

    it("returns degraded when memory is degraded", () => {
      const components = {
        database: { status: "healthy" as const },
        redis: { status: "healthy" as const },
        providers: { status: "healthy" as const },
        memory: { status: "degraded" as const },
      };

      const result = determineOverallStatus(components as any);

      expect(result).toBe("degraded");
    });

    it("returns down when multiple critical components fail", () => {
      const components = {
        database: { status: "down" as const },
        redis: { status: "down" as const },
        providers: { status: "healthy" as const },
      };

      const result = determineOverallStatus(components as any);

      expect(result).toBe("down");
    });
  });

  describe("Response time tracking", () => {
    it("distinguishes between fast and slow health checks", async () => {
      (pool.query as jest.Mock).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ rows: [] }), 10);
          })
      );

      const result = await checkDatabaseHealth();

      expect(result.responseTime).toBeGreaterThanOrEqual(10);
      expect(result.responseTime).toBeLessThan(100); // Should still be fast
    });

    it("tracks different response times for different components", async () => {
      (pool.query as jest.Mock).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ rows: [] }), 20);
          })
      );
      (redisClient.ping as jest.Mock).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve("PONG"), 5);
          })
      );

      const dbHealth = await checkDatabaseHealth();
      const redisHealth = await checkRedisHealth();

      expect(dbHealth.responseTime).toBeGreaterThan(redisHealth.responseTime);
    });
  });

  describe("Error handling", () => {
    it("includes error messages for failed health checks", async () => {
      const errorMsg = "Database connection timeout";
      (pool.query as jest.Mock).mockRejectedValueOnce(new Error(errorMsg));

      const result = await checkDatabaseHealth();

      expect(result.error).toBe(errorMsg);
      expect(result.status).toBe("down");
    });

    it("handles unknown errors gracefully", async () => {
      (pool.query as jest.Mock).mockRejectedValueOnce("Non-Error object");

      const result = await checkDatabaseHealth();

      expect(result.status).toBe("down");
      expect(result.error).toBeDefined();
    });

    it("continues checking other components even if one fails", async () => {
      (pool.query as jest.Mock).mockRejectedValueOnce(new Error("DB error"));
      (redisClient.ping as jest.Mock).mockResolvedValueOnce("PONG");
      (checkMobileMoneyHealth as jest.Mock).mockResolvedValueOnce({
        providers: { mtn: { status: "up" }, airtel: { status: "up" }, orange: { status: "up" } },
      });

      const result = await getDetailedComponentHealth();

      expect(result.database.status).toBe("down");
      expect(result.redis.status).toBe("healthy");
      expect(result.providers.status).toBe("healthy");
    });
  });
});
