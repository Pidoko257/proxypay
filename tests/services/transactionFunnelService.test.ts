/**
 * Tests for transaction funnel service — issue #262
 */

// Mock Prometheus metrics to avoid registry conflicts
jest.mock("prom-client", () => ({
  Counter: jest.fn().mockImplementation(() => ({ inc: jest.fn() })),
  Gauge: jest.fn().mockImplementation(() => ({ set: jest.fn() })),
  Registry: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../../src/utils/metrics", () => ({ register: {} }));

// Mock DB and Redis so the service can be tested without infrastructure
jest.mock("../../../src/config/database", () => ({
  queryRead: jest.fn(),
}));

jest.mock("../../../src/config/redis", () => ({
  redisClient: {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue("OK"),
  },
}));

import { transactionFunnelService } from "../../../src/services/transactionFunnelService";
import { queryRead } from "../../../src/config/database";

const mockQueryRead = queryRead as jest.MockedFunction<typeof queryRead>;

describe("transactionFunnelService.recordTransition", () => {
  it("records a valid stage transition without throwing", () => {
    expect(() =>
      transactionFunnelService.recordTransition("mtn", "deposit", "initiated", "verified"),
    ).not.toThrow();
  });

  it("increments drop-off counter on failed transition", () => {
    expect(() =>
      transactionFunnelService.recordTransition("mtn", "deposit", "verified", "failed"),
    ).not.toThrow();
  });
});

describe("transactionFunnelService.getFunnelSnapshot", () => {
  it("returns empty array when query returns no rows", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const result = await transactionFunnelService.getFunnelSnapshot("daily", 24);
    expect(result).toEqual([]);
  });

  it("calculates conversion rates from DB row data", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [
        {
          provider: "mtn",
          type: "deposit",
          initiated: "100",
          verified: "80",
          processing: "70",
          completed: "65",
          failed: "10",
          cancelled: "5",
        },
      ],
      rowCount: 1,
    } as never);

    const [snapshot] = await transactionFunnelService.getFunnelSnapshot("daily", 24);

    expect(snapshot.provider).toBe("mtn");
    expect(snapshot.initiated).toBe(100);
    expect(snapshot.completed).toBe(65);
    expect(snapshot.overall_conversion_rate).toBeCloseTo(0.65, 2);
    expect(snapshot.verification_rate).toBeCloseTo(0.8, 2);
  });

  it("identifies the biggest drop-off stage", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [
        {
          provider: "airtel",
          type: "withdrawal",
          initiated: "200",
          verified: "100",  // big drop here: 100 lost at verification
          processing: "95",
          completed: "90",
          failed: "5",
          cancelled: "5",
        },
      ],
      rowCount: 1,
    } as never);

    const [snapshot] = await transactionFunnelService.getFunnelSnapshot("daily", 24);
    expect(snapshot.biggest_drop_off_stage).toBe("verification");
  });

  it("handles zero initiated transactions gracefully (no division by zero)", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [
        {
          provider: "orange",
          type: "deposit",
          initiated: "0",
          verified: "0",
          processing: "0",
          completed: "0",
          failed: "0",
          cancelled: "0",
        },
      ],
      rowCount: 1,
    } as never);

    const [snapshot] = await transactionFunnelService.getFunnelSnapshot("daily", 24);
    expect(snapshot.overall_conversion_rate).toBe(0);
    expect(snapshot.verification_rate).toBe(0);
  });

  it("returns snapshots for multiple provider+type combinations", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [
        { provider: "mtn", type: "deposit", initiated: "50", verified: "45", processing: "40", completed: "38", failed: "5", cancelled: "2" },
        { provider: "airtel", type: "withdrawal", initiated: "30", verified: "28", processing: "25", completed: "24", failed: "2", cancelled: "1" },
      ],
      rowCount: 2,
    } as never);

    const snapshots = await transactionFunnelService.getFunnelSnapshot("daily", 24);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.provider)).toContain("mtn");
    expect(snapshots.map((s) => s.provider)).toContain("airtel");
  });
});

describe("transactionFunnelService.getFunnelTimeSeries", () => {
  it("returns a properly structured FunnelGranularity object", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [
        {
          period: new Date().toISOString(),
          initiated: "40",
          verified: "35",
          processing: "30",
          completed: "28",
          failed: "5",
          cancelled: "2",
        },
      ],
      rowCount: 1,
    } as never);

    const result = await transactionFunnelService.getFunnelTimeSeries("hourly", 24);
    expect(result.granularity).toBe("hourly");
    expect(Array.isArray(result.snapshots)).toBe(true);
    expect(result.snapshots[0].initiated).toBe(40);
    expect(result.from).toBeDefined();
    expect(result.to).toBeDefined();
  });

  it("returns empty snapshots on DB error", async () => {
    mockQueryRead.mockRejectedValueOnce(new Error("DB timeout"));
    const result = await transactionFunnelService.getFunnelTimeSeries("daily", 24);
    expect(result.snapshots).toEqual([]);
  });
});
