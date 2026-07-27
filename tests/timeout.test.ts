/**
 * Unit tests for the timeout subsystem:
 *  - timeoutPolicies.ts
 *  - timeoutService.ts
 *  - transactionRecovery.ts
 */

// Mock prom-client metrics before any imports to avoid duplicate-registration errors
jest.mock("../src/utils/metrics", () => ({
  register: { contentType: "text/plain", metrics: jest.fn() },
  httpRequestsTotal: { inc: jest.fn() },
  httpRequestDurationSeconds: { observe: jest.fn() },
  transactionTotal: { inc: jest.fn() },
  transactionErrorsTotal: { inc: jest.fn() },
  providerResponseTimeSeconds: { observe: jest.fn() },
  providerResponseTimeSummary: { observe: jest.fn() },
  providerFailoverTotal: { inc: jest.fn() },
  providerFailoverAlerts: { inc: jest.fn() },
  providerCircuitBreakerTransitionsTotal: { inc: jest.fn() },
  providerCircuitBreakerState: { set: jest.fn() },
  horizonNodeFailuresTotal: { inc: jest.fn() },
  horizonNodeHealth: { set: jest.fn() },
  horizonRequestFailoverTotal: { inc: jest.fn() },
  healthCheckResponseTimeSeconds: { observe: jest.fn() },
  batchPayoutTotal: { inc: jest.fn() },
  batchPayoutItemsTotal: { inc: jest.fn() },
  batchPayoutDurationSeconds: { observe: jest.fn() },
  batchPayoutSize: { observe: jest.fn() },
  activeConnections: { inc: jest.fn(), dec: jest.fn() },
  dbReplicaLagSeconds: { set: jest.fn() },
  dbReplicaReadEnabled: { set: jest.fn() },
  cacheHitsTotal: { inc: jest.fn() },
  cacheMissesTotal: { inc: jest.fn() },
  cacheHitRatio: { set: jest.fn() },
  crossChainBalanceGauge: { set: jest.fn() },
  crossChainAnomalyTotal: { inc: jest.fn() },
  systemHeartbeat: { set: jest.fn() },
}));

jest.mock("../src/middleware/timeoutMetrics", () => ({
  timeoutTotal: { inc: jest.fn() },
  slowRequestTotal: { inc: jest.fn() },
  timeoutDurationSeconds: { observe: jest.fn() },
  timeoutRecoveryTotal: { inc: jest.fn() },
}));

jest.mock("../src/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── timeoutPolicies ────────────────────────────────────────────────────────

import {
  OperationType,
  TIMEOUT_POLICIES,
  resolvePolicy,
  inferOperationType,
  getAllPolicySummaries,
} from "../src/utils/timeoutPolicies";

describe("timeoutPolicies", () => {
  describe("TIMEOUT_POLICIES registry", () => {
    it("has a policy for every OperationType", () => {
      for (const op of Object.values(OperationType)) {
        expect(TIMEOUT_POLICIES[op]).toBeDefined();
        expect(TIMEOUT_POLICIES[op].timeoutMs).toBeGreaterThan(0);
      }
    });

    it("warning threshold is always less than hard timeout", () => {
      for (const op of Object.values(OperationType)) {
        const p = TIMEOUT_POLICIES[op];
        expect(p.warningThresholdMs).toBeLessThan(p.timeoutMs);
      }
    });

    it("PROVIDER_PAYMENT enables partial recovery and alerting", () => {
      const p = TIMEOUT_POLICIES[OperationType.PROVIDER_PAYMENT];
      expect(p.enablePartialRecovery).toBe(true);
      expect(p.alertOnTimeout).toBe(true);
    });

    it("BLOCKCHAIN_SUBMIT enables partial recovery and alerting", () => {
      const p = TIMEOUT_POLICIES[OperationType.BLOCKCHAIN_SUBMIT];
      expect(p.enablePartialRecovery).toBe(true);
      expect(p.alertOnTimeout).toBe(true);
    });

    it("HEALTH_CHECK has the shortest timeout of all policies", () => {
      const hcMs = TIMEOUT_POLICIES[OperationType.HEALTH_CHECK].timeoutMs;
      const allMs = Object.values(TIMEOUT_POLICIES).map((p) => p.timeoutMs);
      expect(hcMs).toBe(Math.min(...allMs));
    });

    it("BATCH_OPERATION has the longest timeout of all policies", () => {
      const batchMs = TIMEOUT_POLICIES[OperationType.BATCH_OPERATION].timeoutMs;
      const allMs = Object.values(TIMEOUT_POLICIES).map((p) => p.timeoutMs);
      expect(batchMs).toBe(Math.max(...allMs));
    });
  });

  describe("resolvePolicy", () => {
    afterEach(() => {
      delete process.env.TIMEOUT_PROVIDER_PAYMENT_MS;
      delete process.env.TIMEOUT_PROVIDER_PAYMENT_MAX_RETRIES;
      delete process.env.TIMEOUT_PROVIDER_PAYMENT_WARNING_MS;
    });

    it("returns base policy when no env overrides set", () => {
      expect(resolvePolicy(OperationType.PROVIDER_PAYMENT)).toEqual(
        TIMEOUT_POLICIES[OperationType.PROVIDER_PAYMENT],
      );
    });

    it("applies _MS env override", () => {
      process.env.TIMEOUT_PROVIDER_PAYMENT_MS = "99000";
      expect(resolvePolicy(OperationType.PROVIDER_PAYMENT).timeoutMs).toBe(99000);
    });

    it("applies _MAX_RETRIES env override", () => {
      process.env.TIMEOUT_PROVIDER_PAYMENT_MAX_RETRIES = "7";
      expect(resolvePolicy(OperationType.PROVIDER_PAYMENT).maxRetries).toBe(7);
    });

    it("applies _WARNING_MS env override", () => {
      process.env.TIMEOUT_PROVIDER_PAYMENT_WARNING_MS = "10000";
      expect(resolvePolicy(OperationType.PROVIDER_PAYMENT).warningThresholdMs).toBe(10000);
    });
  });

  describe("inferOperationType", () => {
    const cases: [string, string, OperationType][] = [
      ["/health", "GET", OperationType.HEALTH_CHECK],
      ["/ready", "GET", OperationType.HEALTH_CHECK],
      ["/ping", "GET", OperationType.HEALTH_CHECK],
      ["/api/auth/login", "POST", OperationType.AUTH],
      ["/oauth/token", "POST", OperationType.AUTH],
      ["/api/transactions/deposit", "POST", OperationType.PROVIDER_PAYMENT],
      ["/api/transactions/withdraw", "POST", OperationType.PROVIDER_PAYMENT],
      ["/api/transactions/bulk", "POST", OperationType.BATCH_OPERATION],
      ["/api/kyc/submit", "POST", OperationType.KYC],
      ["/sep10/auth", "POST", OperationType.STELLAR_SEP],
      ["/sep24/transactions/deposit/interactive", "POST", OperationType.STELLAR_SEP],
      ["/sep31/transactions", "POST", OperationType.STELLAR_SEP],
      ["/api/reports", "GET", OperationType.REPORT_GENERATION],
      ["/api/statements", "GET", OperationType.REPORT_GENERATION],
      ["/api/transactions", "GET", OperationType.READ],
      ["/api/users/me", "GET", OperationType.READ],
      ["/api/users/me", "PUT", OperationType.WRITE],
      ["/api/webhooks/deliver", "POST", OperationType.WEBHOOK_DELIVERY],
    ];

    it.each(cases)("path=%s method=%s → %s", (path, method, expected) => {
      expect(inferOperationType(path, method)).toBe(expected);
    });
  });

  describe("getAllPolicySummaries", () => {
    it("returns one entry per OperationType", () => {
      expect(getAllPolicySummaries()).toHaveLength(Object.values(OperationType).length);
    });

    it("every entry has a non-empty label", () => {
      for (const s of getAllPolicySummaries()) {
        expect(s.policy.label).toBeTruthy();
      }
    });
  });
});

// ─── TimeoutService ──────────────────────────────────────────────────────────

import { TimeoutService } from "../src/services/timeoutService";

describe("TimeoutService", () => {
  let svc: TimeoutService;

  beforeEach(() => {
    svc = new TimeoutService();
    svc.clearBuffer();
    jest.clearAllMocks();
  });

  afterEach(() => {
    svc.stopAlertMonitor();
  });

  it("adds events to the ring buffer", async () => {
    await svc.recordTimeout({ operationType: OperationType.PROVIDER_PAYMENT, path: "/deposit", method: "POST", elapsedMs: 61_000 });
    expect(svc.bufferSize).toBe(1);
  });

  it("caps ring buffer at 1000 entries", async () => {
    const tasks = Array.from({ length: 1_010 }, () =>
      svc.recordTimeout({ operationType: OperationType.READ, path: "/t", method: "GET", elapsedMs: 1_000 }),
    );
    await Promise.all(tasks);
    expect(svc.bufferSize).toBe(1_000);
  });

  it("getStats returns zeros on empty buffer", () => {
    const s = svc.getStats();
    expect(s.totalTimeouts).toBe(0);
    expect(s.alertActive).toBe(false);
    expect(s.lastTimeoutAt).toBeNull();
  });

  it("getStats counts by operation type", async () => {
    await svc.recordTimeout({ operationType: OperationType.PROVIDER_PAYMENT, path: "/a", method: "POST", elapsedMs: 62_000 });
    await svc.recordTimeout({ operationType: OperationType.PROVIDER_PAYMENT, path: "/b", method: "POST", elapsedMs: 63_000 });
    await svc.recordTimeout({ operationType: OperationType.BLOCKCHAIN_SUBMIT, path: "/c", method: "POST", elapsedMs: 91_000 });
    const s = svc.getStats();
    expect(s.byOperationType[OperationType.PROVIDER_PAYMENT]).toBe(2);
    expect(s.byOperationType[OperationType.BLOCKCHAIN_SUBMIT]).toBe(1);
    expect(s.totalTimeouts).toBe(3);
  });

  it("last5MinTimeouts excludes old events", async () => {
    await svc.recordTimeout({ operationType: OperationType.READ, path: "/old", method: "GET", elapsedMs: 12_000, occurredAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    await svc.recordTimeout({ operationType: OperationType.READ, path: "/new", method: "GET", elapsedMs: 11_000 });
    const s = svc.getStats();
    expect(s.totalTimeouts).toBe(2);
    expect(s.last5MinTimeouts).toBe(1);
  });

  it("computes avgElapsedMs correctly", async () => {
    await svc.recordTimeout({ operationType: OperationType.READ, path: "/a", method: "GET", elapsedMs: 10_000 });
    await svc.recordTimeout({ operationType: OperationType.READ, path: "/b", method: "GET", elapsedMs: 20_000 });
    expect(svc.getStats().avgElapsedMs).toBe(15_000);
  });

  it("activates alert when threshold exceeded", async () => {
    (svc as any).alertThresholdPerMinute = 2;
    await svc.recordTimeout({ operationType: OperationType.PROVIDER_PAYMENT, path: "/d", method: "POST", elapsedMs: 61_000 });
    await svc.recordTimeout({ operationType: OperationType.PROVIDER_PAYMENT, path: "/d", method: "POST", elapsedMs: 61_500 });
    expect(svc.getStats().alertActive).toBe(true);
  });

  it("does not activate alert below threshold", async () => {
    (svc as any).alertThresholdPerMinute = 10;
    await svc.recordTimeout({ operationType: OperationType.READ, path: "/e", method: "GET", elapsedMs: 10_001 });
    expect(svc.getStats().alertActive).toBe(false);
  });

  it("clearBuffer resets state", async () => {
    (svc as any).alertThresholdPerMinute = 1;
    await svc.recordTimeout({ operationType: OperationType.READ, path: "/f", method: "GET", elapsedMs: 10_001 });
    svc.clearBuffer();
    expect(svc.bufferSize).toBe(0);
    expect(svc.getStats().alertActive).toBe(false);
  });

  it("reads TIMEOUT_ALERT_THRESHOLD_PER_MIN from env", () => {
    process.env.TIMEOUT_ALERT_THRESHOLD_PER_MIN = "42";
    const svc2 = new TimeoutService();
    expect((svc2 as any).alertThresholdPerMinute).toBe(42);
    delete process.env.TIMEOUT_ALERT_THRESHOLD_PER_MIN;
    svc2.stopAlertMonitor();
  });
});

// ─── TransactionRecoveryService ──────────────────────────────────────────────

import { TransactionRecoveryService, RecoveryStatus, RecoveryContext } from "../src/services/transactionRecovery";
import { timeoutRecoveryTotal } from "../src/middleware/timeoutMetrics";

describe("TransactionRecoveryService", () => {
  let recovery: TransactionRecoveryService;

  beforeEach(() => {
    recovery = new TransactionRecoveryService();
    jest.clearAllMocks();
  });

  const notApplicable = [
    OperationType.READ, OperationType.AUTH, OperationType.WRITE,
    OperationType.BLOCKCHAIN_READ, OperationType.HEALTH_CHECK,
    OperationType.WEBHOOK_DELIVERY, OperationType.REPORT_GENERATION,
    OperationType.WEBSOCKET, OperationType.DEFAULT,
  ];

  it.each(notApplicable)("NOT_APPLICABLE for %s", async (op) => {
    const result = await recovery.attemptRecovery({ operationType: op, elapsedMs: 11_000 });
    expect(result.status).toBe(RecoveryStatus.NOT_APPLICABLE);
  });

  describe("PROVIDER_PAYMENT", () => {
    it("NOT_FOUND without referenceId", async () => {
      const result = await recovery.attemptRecovery({ operationType: OperationType.PROVIDER_PAYMENT, provider: "mtn", elapsedMs: 65_000 });
      expect(result.status).toBe(RecoveryStatus.NOT_FOUND);
      expect(result.message).toMatch(/referenceId/i);
    });

    it("NOT_FOUND without provider", async () => {
      const result = await recovery.attemptRecovery({ operationType: OperationType.PROVIDER_PAYMENT, referenceId: "ref-1", elapsedMs: 65_000 });
      expect(result.status).toBe(RecoveryStatus.NOT_FOUND);
    });

    it("returns a valid RecoveryStatus when called with full context", async () => {
      const result = await recovery.attemptRecovery({ operationType: OperationType.PROVIDER_PAYMENT, provider: "mtn", referenceId: "ref-abc", transactionId: "tx-001", elapsedMs: 65_000 });
      expect(Object.values(RecoveryStatus)).toContain(result.status);
      expect(result.recoveredAt).toBeTruthy();
    });
  });

  describe("BLOCKCHAIN_SUBMIT", () => {
    it("NOT_FOUND without stellarTxHash", async () => {
      const result = await recovery.attemptRecovery({ operationType: OperationType.BLOCKCHAIN_SUBMIT, transactionId: "tx-002", elapsedMs: 92_000 });
      expect(result.status).toBe(RecoveryStatus.NOT_FOUND);
      expect(result.message).toMatch(/stellarTxHash/i);
    });

    it("returns a valid status when hash provided", async () => {
      const result = await recovery.attemptRecovery({ operationType: OperationType.BLOCKCHAIN_SUBMIT, stellarTxHash: "abc123", elapsedMs: 92_000 });
      expect(Object.values(RecoveryStatus)).toContain(result.status);
    });
  });

  describe("BATCH_OPERATION", () => {
    it("returns PENDING", async () => {
      const result = await recovery.attemptRecovery({ operationType: OperationType.BATCH_OPERATION, transactionId: "tx-003", elapsedMs: 185_000 });
      expect(result.status).toBe(RecoveryStatus.PENDING);
      expect(result.newTransactionStatus).toBe("pending");
    });
  });

  it("increments timeoutRecoveryTotal metric", async () => {
    await recovery.attemptRecovery({ operationType: OperationType.READ, elapsedMs: 11_000 });
    expect((timeoutRecoveryTotal as any).inc).toHaveBeenCalledWith({ operation_type: OperationType.READ, status: RecoveryStatus.NOT_APPLICABLE });
  });

  it("always returns a result shape (never throws)", async () => {
    const result = await recovery.attemptRecovery({ operationType: OperationType.KYC, elapsedMs: 1_000 });
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("recoveredAt");
  });
});
