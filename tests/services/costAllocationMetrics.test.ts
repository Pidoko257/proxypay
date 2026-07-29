/**
 * Tests for cost allocation metrics service — issue #261
 */

// Mock prom-client so tests don't conflict with the global registry
jest.mock("prom-client", () => {
  const makeCounter = () => ({ inc: jest.fn() });
  const makeHistogram = () => ({ observe: jest.fn() });
  const makeGauge = () => ({ set: jest.fn() });
  return {
    Counter: jest.fn().mockImplementation(makeCounter),
    Histogram: jest.fn().mockImplementation(makeHistogram),
    Gauge: jest.fn().mockImplementation(makeGauge),
    Registry: jest.fn().mockImplementation(() => ({})),
  };
});

// Mock the utils/metrics registry so the counters don't clash
jest.mock("../../../src/utils/metrics", () => ({ register: {} }));

import { costMetrics } from "../../../src/services/costAllocationMetrics";

beforeEach(() => {
  costMetrics._reset();
});

describe("costMetrics.recordApiCall", () => {
  it("accumulates api_calls in the analytics output", () => {
    costMetrics.recordApiCall("mtn", "deposit", 120, "success");
    costMetrics.recordApiCall("mtn", "deposit", 95, "success");

    const records = costMetrics.getUnitCostAnalytics();
    const row = records.find((r) => r.provider === "mtn" && r.feature === "deposit");
    expect(row?.api_calls).toBe(2);
  });

  it("tracks errors separately from successes via status label", () => {
    costMetrics.recordApiCall("airtel", "withdraw", 300, "error");
    costMetrics.recordApiCall("airtel", "withdraw", 150, "success");

    const records = costMetrics.getUnitCostAnalytics();
    const row = records.find((r) => r.provider === "airtel" && r.feature === "withdraw");
    // Both calls accumulate into api_calls (status is a Prometheus label, not split here)
    expect(row?.api_calls).toBe(2);
  });
});

describe("costMetrics.recordDbQuery", () => {
  it("accumulates db_queries", () => {
    costMetrics.recordDbQuery("orange", "kyc", 10, "read");
    costMetrics.recordDbQuery("orange", "kyc", 8, "write");

    const records = costMetrics.getUnitCostAnalytics();
    const row = records.find((r) => r.provider === "orange" && r.feature === "kyc");
    expect(row?.db_queries).toBe(2);
  });
});

describe("costMetrics.recordStorageOp", () => {
  it("accumulates storage_bytes", () => {
    costMetrics.recordStorageOp("mtn", "kyc", 1024 * 500); // 500 KB
    costMetrics.recordStorageOp("mtn", "kyc", 1024 * 200); // 200 KB

    const records = costMetrics.getUnitCostAnalytics();
    const row = records.find((r) => r.provider === "mtn" && r.feature === "kyc");
    expect(row?.storage_bytes).toBe(1024 * 700);
  });
});

describe("costMetrics.recordTransaction + unit cost calculation", () => {
  it("calculates non-zero cost per transaction after recording resources", () => {
    // Simulate 10 API calls and 20 DB queries for 5 transactions
    for (let i = 0; i < 10; i++) costMetrics.recordApiCall("mtn", "deposit", 100);
    for (let i = 0; i < 20; i++) costMetrics.recordDbQuery("mtn", "deposit", 10);
    for (let i = 0; i < 5; i++) costMetrics.recordTransaction("mtn", "deposit");

    const records = costMetrics.getUnitCostAnalytics();
    const row = records.find((r) => r.provider === "mtn" && r.feature === "deposit");

    expect(row?.total_transactions).toBe(5);
    expect(row?.estimated_total_cost_usd_cents_per_tx).toBeGreaterThan(0);
    expect(row?.estimated_api_cost_usd_cents_per_tx).toBeGreaterThan(0);
    expect(row?.estimated_db_cost_usd_cents_per_tx).toBeGreaterThan(0);
  });

  it("returns zero cost per transaction when no transactions recorded", () => {
    costMetrics.recordApiCall("airtel", "deposit", 100);

    const records = costMetrics.getUnitCostAnalytics();
    const row = records.find((r) => r.provider === "airtel" && r.feature === "deposit");
    expect(row?.estimated_total_cost_usd_cents_per_tx).toBe(0);
  });
});

describe("costMetrics.getUnitCostAnalytics", () => {
  it("returns empty array when no data recorded", () => {
    expect(costMetrics.getUnitCostAnalytics()).toEqual([]);
  });

  it("sorts records by total cost descending (most expensive first)", () => {
    // mtn/deposit: 100 API calls → expensive
    for (let i = 0; i < 100; i++) costMetrics.recordApiCall("mtn", "deposit", 50);
    costMetrics.recordTransaction("mtn", "deposit");

    // airtel/withdraw: 1 API call → cheap
    costMetrics.recordApiCall("airtel", "withdraw", 50);
    costMetrics.recordTransaction("airtel", "withdraw");

    const records = costMetrics.getUnitCostAnalytics();
    expect(records[0].provider).toBe("mtn");
    expect(records[0].feature).toBe("deposit");
  });

  it("keeps separate entries per provider+feature combination", () => {
    costMetrics.recordApiCall("mtn", "deposit", 100);
    costMetrics.recordApiCall("mtn", "withdraw", 100);
    costMetrics.recordApiCall("airtel", "deposit", 100);

    const records = costMetrics.getUnitCostAnalytics();
    expect(records.length).toBe(3);
  });

  it("identifies expensive features by api_calls", () => {
    for (let i = 0; i < 50; i++) costMetrics.recordApiCall("mtn", "kyc", 200);
    costMetrics.recordTransaction("mtn", "kyc");

    for (let i = 0; i < 5; i++) costMetrics.recordApiCall("mtn", "deposit", 100);
    costMetrics.recordTransaction("mtn", "deposit");

    const records = costMetrics.getUnitCostAnalytics();
    // KYC should be more expensive (50 API calls / 1 tx vs 5 / 1 tx)
    const kyc = records.find((r) => r.feature === "kyc");
    const deposit = records.find((r) => r.feature === "deposit");
    expect(kyc!.estimated_api_cost_usd_cents_per_tx).toBeGreaterThan(
      deposit!.estimated_api_cost_usd_cents_per_tx,
    );
  });
});
