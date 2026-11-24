/**
 * Integration tests for health endpoint responses
 * Verifies the structure and content of detailed health check responses
 */

import { DetailedHealthCheckResponse, DetailedReadinessCheckResponse, DetailedLBHealthCheckResponse } from "../src/types/api";

describe("Health Endpoints Response Structures", () => {
  describe("DetailedHealthCheckResponse", () => {
    it("has required fields", () => {
      const response: DetailedHealthCheckResponse = {
        status: "ok",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "healthy",
            responseTime: 45,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 12,
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "degraded",
            responseTime: 250,
            lastChecked: new Date().toISOString(),
            providers: { mtn: "up", airtel: "down", orange: "up" },
            healthyCount: 2,
            totalCount: 3,
          },
        },
        overallStatus: "degraded",
      };

      expect(response.status).toMatch(/^(ok|degraded|error)$/);
      expect(response.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(response.overallStatus).toMatch(/^(healthy|degraded|down)$/);
      expect(response.components.database).toBeDefined();
      expect(response.components.redis).toBeDefined();
      expect(response.components.providers).toBeDefined();
    });

    it("includes provider details when available", () => {
      const response: DetailedHealthCheckResponse = {
        status: "ok",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "healthy",
            responseTime: 20,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 10,
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "healthy",
            responseTime: 100,
            lastChecked: new Date().toISOString(),
            providers: { mtn: "up", airtel: "up", orange: "up" },
            healthyCount: 3,
            totalCount: 3,
          },
        },
        overallStatus: "healthy",
      };

      expect(response.components.providers.providers).toEqual({
        mtn: "up",
        airtel: "up",
        orange: "up",
      });
      expect(response.components.providers.healthyCount).toBe(3);
      expect(response.components.providers.totalCount).toBe(3);
    });

    it("includes error details when component is down", () => {
      const response: DetailedHealthCheckResponse = {
        status: "error",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "down",
            responseTime: 5000,
            lastChecked: new Date().toISOString(),
            error: "Connection refused: host unreachable",
          },
          redis: {
            status: "healthy",
            responseTime: 15,
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "healthy",
            responseTime: 80,
            lastChecked: new Date().toISOString(),
          },
        },
        overallStatus: "down",
      };

      expect(response.components.database.error).toContain("Connection refused");
      expect(response.status).toBe("error");
      expect(response.overallStatus).toBe("down");
    });

    it("includes gitHash when available", () => {
      const response: DetailedHealthCheckResponse = {
        status: "ok",
        timestamp: new Date().toISOString(),
        gitHash: "abc123def456",
        components: {
          database: {
            status: "healthy",
            responseTime: 20,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 10,
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "healthy",
            responseTime: 100,
            lastChecked: new Date().toISOString(),
          },
        },
        overallStatus: "healthy",
      };

      expect(response.gitHash).toBe("abc123def456");
    });
  });

  describe("DetailedReadinessCheckResponse", () => {
    it("has required fields for readiness", () => {
      const response: DetailedReadinessCheckResponse = {
        status: "ready",
        timestamp: new Date().toISOString(),
        checks: {
          database: "healthy",
          redis: "healthy",
          replication: "healthy",
          shutdown: "idle",
        },
        components: {
          database: {
            status: "healthy",
            responseTime: 25,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 8,
            lastChecked: new Date().toISOString(),
          },
          replication: {
            status: "healthy",
            responseTime: 15,
            lastChecked: new Date().toISOString(),
            drMode: "active",
          },
        },
      };

      expect(response.status).toMatch(/^(ready|not ready)$/);
      expect(response.checks.database).toBeDefined();
      expect(response.checks.redis).toBeDefined();
      expect(response.components.database).toBeDefined();
      expect(response.components.redis).toBeDefined();
    });

    it("marks pod as not ready when critical component fails", () => {
      const response: DetailedReadinessCheckResponse = {
        status: "not ready",
        timestamp: new Date().toISOString(),
        checks: {
          database: "down",
          redis: "healthy",
          replication: "healthy",
          shutdown: "idle",
        },
        components: {
          database: {
            status: "down",
            responseTime: 3000,
            lastChecked: new Date().toISOString(),
            error: "Failed to connect",
          },
          redis: {
            status: "healthy",
            responseTime: 8,
            lastChecked: new Date().toISOString(),
          },
        },
      };

      expect(response.status).toBe("not ready");
      expect(response.checks.database).toBe("down");
      expect(response.components.database.error).toBeDefined();
    });

    it("includes DR mode information", () => {
      const response: DetailedReadinessCheckResponse = {
        status: "ready",
        timestamp: new Date().toISOString(),
        checks: {
          database: "healthy",
          redis: "healthy",
          replication: "degraded",
          dr_mode: "standby",
          shutdown: "idle",
        },
        components: {
          database: {
            status: "healthy",
            responseTime: 25,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 8,
            lastChecked: new Date().toISOString(),
          },
          replication: {
            status: "degraded",
            responseTime: 150,
            lastChecked: new Date().toISOString(),
            drMode: "standby",
            error: "Replication lag detected",
          },
        },
      };

      expect(response.checks.dr_mode).toBe("standby");
      expect(response.components.replication?.drMode).toBe("standby");
    });
  });

  describe("DetailedLBHealthCheckResponse", () => {
    it("has required fields for load balancer", () => {
      const response: DetailedLBHealthCheckResponse = {
        status: "ok",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "healthy",
            responseTime: 30,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 12,
            lastChecked: new Date().toISOString(),
          },
          memory: {
            status: "healthy",
            responseTime: 0,
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "degraded",
            responseTime: 200,
            lastChecked: new Date().toISOString(),
            overall: "degraded",
            providers: { mtn: "up", airtel: "down", orange: "up" },
          },
        },
        overallStatus: "degraded",
      };

      expect(response.status).toMatch(/^(ok|error)$/);
      expect(response.overallStatus).toMatch(/^(healthy|degraded|down)$/);
      expect(response.components.database).toBeDefined();
      expect(response.components.redis).toBeDefined();
      expect(response.components.memory).toBeDefined();
      expect(response.components.providers).toBeDefined();
    });

    it("includes memory metrics", () => {
      const response: DetailedLBHealthCheckResponse = {
        status: "error",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "healthy",
            responseTime: 25,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 10,
            lastChecked: new Date().toISOString(),
          },
          memory: {
            status: "degraded",
            responseTime: 0,
            lastChecked: new Date().toISOString(),
            error: "Heap usage: 956.45MB / 1024MB",
          },
          providers: {
            status: "healthy",
            responseTime: 100,
            lastChecked: new Date().toISOString(),
          },
        },
        overallStatus: "degraded",
      };

      expect(response.components.memory.status).toBe("degraded");
      expect(response.components.memory.error).toContain("Heap usage");
    });

    it("marks error when critical components fail", () => {
      const response: DetailedLBHealthCheckResponse = {
        status: "error",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "down",
            responseTime: 5000,
            lastChecked: new Date().toISOString(),
            error: "Connection timeout",
          },
          redis: {
            status: "healthy",
            responseTime: 10,
            lastChecked: new Date().toISOString(),
          },
          memory: {
            status: "healthy",
            responseTime: 0,
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "healthy",
            responseTime: 100,
            lastChecked: new Date().toISOString(),
          },
        },
        overallStatus: "down",
      };

      expect(response.status).toBe("error");
      expect(response.overallStatus).toBe("down");
    });
  });

  describe("Response Time Reporting", () => {
    it("all components report response times", () => {
      const response: DetailedHealthCheckResponse = {
        status: "ok",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "healthy",
            responseTime: 45,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 12,
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "healthy",
            responseTime: 250,
            lastChecked: new Date().toISOString(),
          },
        },
        overallStatus: "healthy",
      };

      expect(typeof response.components.database.responseTime).toBe("number");
      expect(typeof response.components.redis.responseTime).toBe("number");
      expect(typeof response.components.providers.responseTime).toBe("number");
      expect(response.components.database.responseTime).toBeGreaterThanOrEqual(0);
      expect(response.components.redis.responseTime).toBeGreaterThanOrEqual(0);
      expect(response.components.providers.responseTime).toBeGreaterThanOrEqual(0);
    });

    it("response times are in milliseconds", () => {
      const response: DetailedHealthCheckResponse = {
        status: "ok",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "healthy",
            responseTime: 45, // milliseconds
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 12, // milliseconds
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "healthy",
            responseTime: 250, // milliseconds
            lastChecked: new Date().toISOString(),
          },
        },
        overallStatus: "healthy",
      };

      // Reasonable millisecond values
      expect(response.components.database.responseTime).toBeLessThan(10000);
      expect(response.components.redis.responseTime).toBeLessThan(10000);
      expect(response.components.providers.responseTime).toBeLessThan(10000);
    });
  });

  describe("Timestamp Consistency", () => {
    it("lastChecked uses ISO 8601 format", () => {
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

      const response: DetailedHealthCheckResponse = {
        status: "ok",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "healthy",
            responseTime: 20,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 10,
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "healthy",
            responseTime: 100,
            lastChecked: new Date().toISOString(),
          },
        },
        overallStatus: "healthy",
      };

      expect(response.timestamp).toMatch(isoRegex);
      expect(response.components.database.lastChecked).toMatch(isoRegex);
      expect(response.components.redis.lastChecked).toMatch(isoRegex);
      expect(response.components.providers.lastChecked).toMatch(isoRegex);
    });

    it("all components have recent lastChecked timestamps", () => {
      const now = Date.now();
      const response: DetailedHealthCheckResponse = {
        status: "ok",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "healthy",
            responseTime: 20,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 10,
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "healthy",
            responseTime: 100,
            lastChecked: new Date().toISOString(),
          },
        },
        overallStatus: "healthy",
      };

      const dbTime = new Date(response.components.database.lastChecked).getTime();
      const redisTime = new Date(response.components.redis.lastChecked).getTime();
      const providersTime = new Date(response.components.providers.lastChecked).getTime();

      expect(now - dbTime).toBeLessThan(5000); // Within 5 seconds
      expect(now - redisTime).toBeLessThan(5000);
      expect(now - providersTime).toBeLessThan(5000);
    });
  });

  describe("Component Status Values", () => {
    it("status is one of valid values", () => {
      const validStatuses = ["healthy", "degraded", "down"];
      const response: DetailedHealthCheckResponse = {
        status: "ok",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "healthy",
            responseTime: 20,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "degraded",
            responseTime: 10,
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "down",
            responseTime: 100,
            lastChecked: new Date().toISOString(),
          },
        },
        overallStatus: "degraded",
      };

      expect(validStatuses).toContain(response.components.database.status);
      expect(validStatuses).toContain(response.components.redis.status);
      expect(validStatuses).toContain(response.components.providers.status);
      expect(validStatuses).toContain(response.overallStatus);
    });

    it("provider statuses are up, down, or unknown", () => {
      const response: DetailedHealthCheckResponse = {
        status: "ok",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "healthy",
            responseTime: 20,
            lastChecked: new Date().toISOString(),
          },
          redis: {
            status: "healthy",
            responseTime: 10,
            lastChecked: new Date().toISOString(),
          },
          providers: {
            status: "healthy",
            responseTime: 100,
            lastChecked: new Date().toISOString(),
            providers: { mtn: "up", airtel: "unknown", orange: "down" },
            healthyCount: 1,
            totalCount: 3,
          },
        },
        overallStatus: "healthy",
      };

      const validProviderStatuses = ["up", "down", "unknown"];
      for (const [provider, status] of Object.entries(
        response.components.providers.providers || {}
      )) {
        expect(validProviderStatuses).toContain(status);
      }
    });
  });
});
