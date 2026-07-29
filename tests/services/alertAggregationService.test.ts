/**
 * Tests for alert aggregation service — issue #263
 */

jest.mock("prom-client", () => ({
  Counter: jest.fn().mockImplementation(() => ({ inc: jest.fn() })),
  Gauge: jest.fn().mockImplementation(() => ({ set: jest.fn() })),
  Registry: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../../src/utils/metrics", () => ({ register: {} }));

jest.mock("../../../src/config/redis", () => ({
  redisClient: {
    setex: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock("../../../src/utils/logger", () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import {
  AlertAggregator,
  AlertPayload,
  AggregatedAlert,
  GroupingRule,
  DEFAULT_GROUPING_RULES,
} from "../../../src/services/alertAggregationService";

function makePayload(overrides: Partial<AlertPayload> = {}): AlertPayload {
  return {
    service: "test-service",
    alertType: "test_alert",
    severity: "warning",
    message: "test message",
    ...overrides,
  };
}

// Use very short windows in tests to avoid real timer waits
const TEST_RULES: GroupingRule[] = [
  { service: "*", alertType: "*", threshold: 3, windowMs: 100 },
];

describe("AlertAggregator — threshold-based firing", () => {
  it("does not fire handler before threshold is reached", () => {
    const handler = jest.fn();
    const agg = new AlertAggregator(TEST_RULES);
    agg.addHandler(handler);

    agg.ingest(makePayload());
    agg.ingest(makePayload());

    expect(handler).not.toHaveBeenCalled();
  });

  it("fires handler exactly once when threshold is reached", () => {
    const handler = jest.fn();
    const agg = new AlertAggregator(TEST_RULES);
    agg.addHandler(handler);

    agg.ingest(makePayload());
    agg.ingest(makePayload());
    agg.ingest(makePayload()); // threshold = 3

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fires immediately when threshold = 1 (critical alerts)", () => {
    const handler = jest.fn();
    const agg = new AlertAggregator([
      { service: "aml", alertType: "*", threshold: 1, windowMs: 60000 },
    ]);
    agg.addHandler(handler);

    agg.ingest(makePayload({ service: "aml", alertType: "suspicious_pattern" }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("passes aggregated count and messages to the handler", () => {
    const handler = jest.fn();
    const agg = new AlertAggregator(TEST_RULES);
    agg.addHandler(handler);

    agg.ingest(makePayload({ message: "msg-1" }));
    agg.ingest(makePayload({ message: "msg-2" }));
    agg.ingest(makePayload({ message: "msg-3" }));

    const fired: AggregatedAlert = handler.mock.calls[0][0];
    expect(fired.count).toBe(3);
    expect(fired.messages).toContain("msg-1");
    expect(fired.messages).toContain("msg-3");
  });

  it("resets the group after firing so subsequent alerts form a new group", () => {
    const handler = jest.fn();
    const agg = new AlertAggregator(TEST_RULES);
    agg.addHandler(handler);

    // First batch — fires at 3
    agg.ingest(makePayload());
    agg.ingest(makePayload());
    agg.ingest(makePayload()); // fires

    expect(handler).toHaveBeenCalledTimes(1);

    // Second batch — fires again at 3
    agg.ingest(makePayload());
    agg.ingest(makePayload());
    agg.ingest(makePayload()); // fires again

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("AlertAggregator — window-based flushing", () => {
  it("flushes when window elapses even if threshold not reached", async () => {
    const handler = jest.fn();
    const agg = new AlertAggregator([
      { service: "*", alertType: "*", threshold: 10, windowMs: 50 },
    ]);
    agg.addHandler(handler);

    agg.ingest(makePayload({ message: "before-flush" }));

    // Wait for window to elapse
    await new Promise((r) => setTimeout(r, 100));

    expect(handler).toHaveBeenCalledTimes(1);
    const fired: AggregatedAlert = handler.mock.calls[0][0];
    expect(fired.count).toBe(1);
  });
});

describe("AlertAggregator — grouping and deduplication", () => {
  it("keeps separate groups for different service+alertType combinations", () => {
    const handler = jest.fn();
    const agg = new AlertAggregator(TEST_RULES);
    agg.addHandler(handler);

    // Each service+alertType combo requires its own 3-alert threshold
    agg.ingest(makePayload({ service: "mtn", alertType: "timeout" }));
    agg.ingest(makePayload({ service: "airtel", alertType: "timeout" }));
    agg.ingest(makePayload({ service: "mtn", alertType: "error" }));

    expect(handler).not.toHaveBeenCalled();
    expect(agg.getActiveGroups()).toHaveLength(3);
  });

  it("groups the same service+alertType together (deduplication)", () => {
    const handler = jest.fn();
    const agg = new AlertAggregator(TEST_RULES);
    agg.addHandler(handler);

    agg.ingest(makePayload({ service: "mtn", alertType: "timeout", message: "t1" }));
    agg.ingest(makePayload({ service: "mtn", alertType: "timeout", message: "t2" }));
    agg.ingest(makePayload({ service: "mtn", alertType: "timeout", message: "t3" }));

    expect(handler).toHaveBeenCalledTimes(1);
    const fired: AggregatedAlert = handler.mock.calls[0][0];
    expect(fired.count).toBe(3);
    expect(fired.service).toBe("mtn");
  });

  it("uses custom groupBy key to sub-group within a service+alertType", () => {
    const handler = jest.fn();
    const agg = new AlertAggregator(TEST_RULES);
    agg.addHandler(handler);

    // Two different groupBy keys → separate groups
    agg.ingest(makePayload({ groupBy: "region-a" }));
    agg.ingest(makePayload({ groupBy: "region-b" }));

    expect(agg.getActiveGroups()).toHaveLength(2);
  });

  it("tracks max severity across grouped alerts", () => {
    const handler = jest.fn();
    const agg = new AlertAggregator(TEST_RULES);
    agg.addHandler(handler);

    agg.ingest(makePayload({ severity: "info" }));
    agg.ingest(makePayload({ severity: "warning" }));
    agg.ingest(makePayload({ severity: "critical" })); // fires

    const fired: AggregatedAlert = handler.mock.calls[0][0];
    expect(fired.maxSeverity).toBe("critical");
  });
});

describe("AlertAggregator — rule resolution", () => {
  it("matches exact service+alertType rule over wildcard", () => {
    const handler = jest.fn();
    const agg = new AlertAggregator([
      { service: "mtn", alertType: "timeout", threshold: 2, windowMs: 60000 }, // exact
      { service: "*", alertType: "*", threshold: 10, windowMs: 60000 },       // catch-all
    ]);
    agg.addHandler(handler);

    agg.ingest(makePayload({ service: "mtn", alertType: "timeout" }));
    agg.ingest(makePayload({ service: "mtn", alertType: "timeout" })); // fires at 2

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("AlertAggregator — upsertRule and setRules", () => {
  it("upsertRule updates an existing rule", () => {
    const agg = new AlertAggregator(DEFAULT_GROUPING_RULES);
    agg.upsertRule({ service: "aml", alertType: "*", threshold: 5, windowMs: 60000 });

    const rules = agg.getRules();
    const amlRule = rules.find((r) => r.service === "aml" && r.alertType === "*");
    expect(amlRule?.threshold).toBe(5);
  });

  it("setRules replaces all rules", () => {
    const agg = new AlertAggregator(DEFAULT_GROUPING_RULES);
    agg.setRules([{ service: "test", alertType: "test_alert", threshold: 99, windowMs: 1000 }]);

    expect(agg.getRules()).toHaveLength(1);
  });
});

describe("AlertAggregator — flushAll", () => {
  it("fires all pending groups on flushAll()", async () => {
    const handler = jest.fn();
    const agg = new AlertAggregator(TEST_RULES);
    agg.addHandler(handler);

    agg.ingest(makePayload({ service: "svc-a", alertType: "alert_a" }));
    agg.ingest(makePayload({ service: "svc-b", alertType: "alert_b" }));

    expect(agg.getActiveGroups()).toHaveLength(2);
    await agg.flushAll();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(agg.getActiveGroups()).toHaveLength(0);
  });
});

describe("AlertAggregator — deduplication target (≥ 70 % reduction)", () => {
  it("achieves ≥ 70 % notification reduction for bursting transient alerts", () => {
    let firedCount = 0;
    let ingestedCount = 0;

    const agg = new AlertAggregator([
      { service: "*", alertType: "*", threshold: 5, windowMs: 60000 },
    ]);
    agg.addHandler(() => { firedCount++; });

    // Simulate 100 rapid transient alerts
    for (let i = 0; i < 100; i++) {
      agg.ingest(makePayload());
      ingestedCount++;
    }

    // 100 ingested / threshold 5 → 20 fired = 80 % reduction
    const reductionPct = 1 - firedCount / ingestedCount;
    expect(reductionPct).toBeGreaterThanOrEqual(0.7);
  });
});
