import { PoolMonitor, PoolMonitoringManager, dbPoolMetrics } from "../../src/services/poolMonitoring";
import { Pool } from "pg";

describe("Pool Monitoring", () => {
  let mockPool: any;
  let monitor: PoolMonitor;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock Pool instance
    mockPool = {
      connect: jest.fn(),
      query: jest.fn(),
    } as any;

    // Simulate internal pool state
    (mockPool as any)._clients = [];
    (mockPool as any)._idleClients = [];
    (mockPool as any)._queue = [];

    monitor = new PoolMonitor(mockPool, "test-pool", {
      maxConnections: 100,
      idleTimeoutMs: 30000,
      saturationThreshold: 80,
      alertThreshold: 90,
    });
  });

  describe("getMetrics", () => {
    it("returns correct pool metrics", () => {
      (mockPool as any)._clients = [{}, {}]; // 2 active
      (mockPool as any)._idleClients = [{}, {}, {}, {}, {}]; // 5 idle
      (mockPool as any)._queue = [{}, {}, {}]; // 3 queued

      const metrics = monitor.getMetrics();

      expect(metrics.activeConnections).toBe(2);
      expect(metrics.idleConnections).toBe(5);
      expect(metrics.totalConnections).toBe(7);
      expect(metrics.queueDepth).toBe(3);
      expect(metrics.utilizationPercent).toBe(2); // 2 / 100 * 100
    });

    it("detects saturation at threshold", () => {
      (mockPool as any)._clients = new Array(85); // 85% utilization
      (mockPool as any)._idleClients = [];
      (mockPool as any)._queue = [];

      const metrics = monitor.getMetrics();

      expect(metrics.saturation).toBe(true);
      expect(metrics.utilizationPercent).toBe(85);
    });

    it("does not flag saturation below threshold", () => {
      (mockPool as any)._clients = new Array(50); // 50% utilization
      (mockPool as any)._idleClients = [];
      (mockPool as any)._queue = [];

      const metrics = monitor.getMetrics();

      expect(metrics.saturation).toBe(false);
      expect(metrics.utilizationPercent).toBe(50);
    });

    it("handles zero pool size gracefully", () => {
      (mockPool as any)._clients = [];
      (mockPool as any)._idleClients = [];
      (mockPool as any)._queue = [];

      const metrics = monitor.getMetrics();

      expect(metrics.activeConnections).toBe(0);
      expect(metrics.idleConnections).toBe(0);
      expect(metrics.queueDepth).toBe(0);
      expect(metrics.utilizationPercent).toBe(0);
    });
  });

  describe("Pool Monitoring Manager", () => {
    let manager: PoolMonitoringManager;

    beforeEach(() => {
      manager = new PoolMonitoringManager();
    });

    it("registers pools", () => {
      const monitor1 = manager.register(mockPool, "pool-1");
      const monitor2 = manager.register(mockPool, "pool-2");

      expect(monitor1).toBeInstanceOf(PoolMonitor);
      expect(monitor2).toBeInstanceOf(PoolMonitor);
      expect(manager.getMonitor("pool-1")).toBe(monitor1);
      expect(manager.getMonitor("pool-2")).toBe(monitor2);
    });

    it("gets all metrics", () => {
      (mockPool as any)._clients = [{}, {}];
      (mockPool as any)._idleClients = [{}, {}];
      (mockPool as any)._queue = [];

      manager.register(mockPool, "pool-1");
      manager.register(mockPool, "pool-2");

      const allMetrics = manager.getAllMetrics();

      expect(allMetrics["pool-1"]).toBeDefined();
      expect(allMetrics["pool-2"]).toBeDefined();
      expect(allMetrics["pool-1"].activeConnections).toBe(2);
    });

    it("stops monitoring", () => {
      const mon1 = manager.register(mockPool, "pool-1");
      const mon2 = manager.register(mockPool, "pool-2");

      jest.spyOn(mon1, "stopMonitoring");
      jest.spyOn(mon2, "stopMonitoring");

      manager.stopAll();

      expect(mon1.stopMonitoring).toHaveBeenCalled();
      expect(mon2.stopMonitoring).toHaveBeenCalled();
    });
  });

  describe("Configuration Recommendations", () => {
    it("provides tuning recommendations", () => {
      (mockPool as any)._clients = new Array(50);
      (mockPool as any)._idleClients = new Array(20);
      (mockPool as any)._queue = [];

      const recommendations = monitor.getConfigRecommendations();

      expect(recommendations.current.max).toBe(100);
      expect(recommendations.recommendations).toBeDefined();
      expect(recommendations.recommendations.recommended_max).toBeGreaterThan(50);
      expect(recommendations.tuning_tips).toBeInstanceOf(Array);
    });

    it("flags over-utilized pools", () => {
      (mockPool as any)._clients = new Array(85);
      (mockPool as any)._idleClients = [];
      (mockPool as any)._queue = [];

      const recommendations = monitor.getConfigRecommendations();

      expect(recommendations.recommendations.reason).toContain("over-utilized");
    });
  });
});
