import { AmlScreeningService, AmlRule, ScreenTransactionInput } from "../amlScreening";
import { AmlScreeningResultModel } from "../../models/amlScreeningResult";
import { pool } from "../../config/database";
import { redisClient } from "../../config/redis";

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock("../../config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../../config/redis", () => ({
  redisClient: {
    get: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
  },
}));

jest.mock("../../models/amlScreeningResult");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<AmlRule> & { ruleType: AmlRule["ruleType"]; config: Record<string, unknown> }): AmlRule {
  return {
    id: "rule-" + Math.random().toString(36).slice(2),
    name: "Test Rule",
    description: null,
    enabled: true,
    ...overrides,
  };
}

function makeInput(overrides: Partial<ScreenTransactionInput> = {}): ScreenTransactionInput {
  return {
    transactionId: "tx-test-001",
    userId: "user-test-001",
    amount: 100_000,
    phoneNumber: "+237600000001",
    type: "deposit",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AmlScreeningService", () => {
  let service: AmlScreeningService;
  let mockResultModel: jest.Mocked<AmlScreeningResultModel>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockResultModel = new AmlScreeningResultModel() as jest.Mocked<AmlScreeningResultModel>;
    mockResultModel.createBulk = jest.fn().mockResolvedValue([]);
    service = new AmlScreeningService(mockResultModel);
  });

  // ── loadRules ──────────────────────────────────────────────────────────────

  describe("loadRules()", () => {
    it("returns enabled rules from the database", async () => {
      const fakeRows = [
        { id: "r1", rule_type: "amount_threshold", name: "Big TX", description: null, config: { threshold_xaf: 1_000_000 }, enabled: true },
        { id: "r2", rule_type: "blacklisted_phone", name: "Blacklist", description: null, config: { numbers: [] }, enabled: true },
      ];
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: fakeRows });

      const rules = await service.loadRules();

      expect(rules).toHaveLength(2);
      expect(rules[0].ruleType).toBe("amount_threshold");
      expect(rules[1].ruleType).toBe("blacklisted_phone");
    });

    it("caches results and avoids a second DB query within TTL", async () => {
      (pool.query as jest.fn).mockResolvedValue({ rows: [] });

      await service.loadRules();
      await service.loadRules();

      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it("re-fetches after invalidateRuleCache() is called", async () => {
      (pool.query as jest.fn).mockResolvedValue({ rows: [] });

      await service.loadRules();
      service.invalidateRuleCache();
      await service.loadRules();

      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });

  // ── amount_threshold ───────────────────────────────────────────────────────

  describe("amount_threshold rule", () => {
    it("triggers when amount equals the threshold", async () => {
      const rule = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: 500_000 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });

      const outcome = await service.screenTransaction(makeInput({ amount: 500_000 }));

      expect(outcome.shouldFlag).toBe(true);
      expect(outcome.matchedRules).toHaveLength(1);
      expect(outcome.matchedRules[0].rule.ruleType).toBe("amount_threshold");
      expect(outcome.matchedRules[0].details).toMatchObject({
        observed_amount: 500_000,
        threshold_xaf: 500_000,
      });
    });

    it("triggers when amount exceeds the threshold", async () => {
      const rule = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: 500_000 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });

      const outcome = await service.screenTransaction(makeInput({ amount: 1_000_000 }));

      expect(outcome.shouldFlag).toBe(true);
    });

    it("does NOT trigger when amount is below threshold", async () => {
      const rule = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: 500_000 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });

      const outcome = await service.screenTransaction(makeInput({ amount: 499_999 }));

      expect(outcome.shouldFlag).toBe(false);
      expect(outcome.matchedRules).toHaveLength(0);
    });

    it("does NOT trigger and returns error detail when config is invalid", async () => {
      const rule = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: -100 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });

      const outcome = await service.screenTransaction(makeInput({ amount: 500_000 }));

      expect(outcome.shouldFlag).toBe(false);
      expect(outcome.allEvaluations[0].details).toMatchObject({ error: expect.any(String) });
    });

    it("evaluates multiple amount_threshold rules independently", async () => {
      const ruleA = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: 500_000 } });
      const ruleB = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: 1_000_000 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(ruleA), toDbRow(ruleB)] });

      // amount triggers ruleA but not ruleB
      const outcome = await service.screenTransaction(makeInput({ amount: 750_000 }));

      expect(outcome.shouldFlag).toBe(true);
      expect(outcome.matchedRules).toHaveLength(1);
      expect(outcome.allEvaluations).toHaveLength(2);
    });
  });

  // ── velocity_check ─────────────────────────────────────────────────────────

  describe("velocity_check rule", () => {
    it("triggers when current Redis count equals max_count", async () => {
      const rule = makeRule({ ruleType: "velocity_check", config: { max_count: 3, window_seconds: 3600 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });
      (redisClient.get as jest.fn).mockResolvedValueOnce("3"); // already 3 → this is the 4th

      const outcome = await service.screenTransaction(makeInput());

      expect(outcome.shouldFlag).toBe(true);
      expect(outcome.matchedRules[0].details).toMatchObject({
        current_count: 3,
        max_count: 3,
      });
    });

    it("triggers when current Redis count exceeds max_count", async () => {
      const rule = makeRule({ ruleType: "velocity_check", config: { max_count: 3, window_seconds: 3600 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });
      (redisClient.get as jest.fn).mockResolvedValueOnce("5");

      const outcome = await service.screenTransaction(makeInput());

      expect(outcome.shouldFlag).toBe(true);
    });

    it("does NOT trigger when count is below max_count", async () => {
      const rule = makeRule({ ruleType: "velocity_check", config: { max_count: 3, window_seconds: 3600 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });
      (redisClient.get as jest.fn).mockResolvedValueOnce("2");

      const outcome = await service.screenTransaction(makeInput());

      expect(outcome.shouldFlag).toBe(false);
    });

    it("does NOT trigger when Redis key is missing (first transaction in window)", async () => {
      const rule = makeRule({ ruleType: "velocity_check", config: { max_count: 3, window_seconds: 3600 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });
      (redisClient.get as jest.fn).mockResolvedValueOnce(null);

      const outcome = await service.screenTransaction(makeInput());

      expect(outcome.shouldFlag).toBe(false);
    });

    it("fails open (does NOT trigger) when Redis is unavailable", async () => {
      const rule = makeRule({ ruleType: "velocity_check", config: { max_count: 3, window_seconds: 3600 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });
      (redisClient.get as jest.fn).mockRejectedValueOnce(new Error("Redis connection refused"));

      const outcome = await service.screenTransaction(makeInput());

      expect(outcome.shouldFlag).toBe(false);
      expect(outcome.allEvaluations[0].details).toMatchObject({ error: expect.stringContaining("Redis unavailable") });
    });

    it("does NOT trigger and returns error detail when config is invalid", async () => {
      const rule = makeRule({ ruleType: "velocity_check", config: { max_count: -1, window_seconds: 0 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });

      const outcome = await service.screenTransaction(makeInput());

      expect(outcome.shouldFlag).toBe(false);
      expect(outcome.allEvaluations[0].details).toMatchObject({ error: expect.any(String) });
    });

    it("uses phone number in the Redis key", async () => {
      const rule = makeRule({ ruleType: "velocity_check", config: { max_count: 3, window_seconds: 3600 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });
      (redisClient.get as jest.fn).mockResolvedValueOnce("0");

      await service.screenTransaction(makeInput({ phoneNumber: "+237699887766" }));

      const calledKey = (redisClient.get as jest.fn).mock.calls[0][0] as string;
      expect(calledKey).toContain("+237699887766");
    });
  });

  // ── blacklisted_phone ──────────────────────────────────────────────────────

  describe("blacklisted_phone rule", () => {
    it("triggers when the phone number is in the blacklist", async () => {
      const rule = makeRule({
        ruleType: "blacklisted_phone",
        config: { numbers: ["+237600000000", "+237611111111"] },
      });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });

      const outcome = await service.screenTransaction(makeInput({ phoneNumber: "+237600000000" }));

      expect(outcome.shouldFlag).toBe(true);
      expect(outcome.matchedRules[0].details).toMatchObject({ matched: true });
    });

    it("does NOT trigger for a clean phone number", async () => {
      const rule = makeRule({
        ruleType: "blacklisted_phone",
        config: { numbers: ["+237600000000"] },
      });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });

      const outcome = await service.screenTransaction(makeInput({ phoneNumber: "+237699887766" }));

      expect(outcome.shouldFlag).toBe(false);
    });

    it("normalises phone numbers before comparison (removes spaces)", async () => {
      const rule = makeRule({
        ruleType: "blacklisted_phone",
        config: { numbers: ["+237 600 000 000"] }, // stored with spaces
      });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });

      // Input without spaces should still match
      const outcome = await service.screenTransaction(makeInput({ phoneNumber: "+237600000000" }));

      expect(outcome.shouldFlag).toBe(true);
    });

    it("does NOT trigger and returns error detail when config.numbers is not an array", async () => {
      const rule = makeRule({
        ruleType: "blacklisted_phone",
        config: { numbers: "not-an-array" },
      });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });

      const outcome = await service.screenTransaction(makeInput());

      expect(outcome.shouldFlag).toBe(false);
      expect(outcome.allEvaluations[0].details).toMatchObject({ error: expect.any(String) });
    });
  });

  // ── combined / multi-rule scenarios ───────────────────────────────────────

  describe("combined rule evaluation", () => {
    it("flags if ANY rule is triggered (OR semantics)", async () => {
      const amountRule = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: 500_000 } });
      const blacklistRule = makeRule({
        ruleType: "blacklisted_phone",
        config: { numbers: ["+237600000000"] },
      });
      (pool.query as jest.fn).mockResolvedValueOnce({
        rows: [toDbRow(amountRule), toDbRow(blacklistRule)],
      });

      // Amount is below threshold, but phone is blacklisted
      const outcome = await service.screenTransaction(
        makeInput({ amount: 100_000, phoneNumber: "+237600000000" }),
      );

      expect(outcome.shouldFlag).toBe(true);
      expect(outcome.matchedRules).toHaveLength(1);
      expect(outcome.matchedRules[0].rule.ruleType).toBe("blacklisted_phone");
    });

    it("collects all triggered rules when multiple fire", async () => {
      const amountRule = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: 500_000 } });
      const blacklistRule = makeRule({
        ruleType: "blacklisted_phone",
        config: { numbers: ["+237600000000"] },
      });
      (pool.query as jest.fn).mockResolvedValueOnce({
        rows: [toDbRow(amountRule), toDbRow(blacklistRule)],
      });

      const outcome = await service.screenTransaction(
        makeInput({ amount: 1_000_000, phoneNumber: "+237600000000" }),
      );

      expect(outcome.shouldFlag).toBe(true);
      expect(outcome.matchedRules).toHaveLength(2);
    });

    it("does NOT flag when no rules are defined", async () => {
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [] });

      const outcome = await service.screenTransaction(makeInput());

      expect(outcome.shouldFlag).toBe(false);
      expect(outcome.allEvaluations).toHaveLength(0);
    });

    it("does NOT flag when no rules trigger", async () => {
      const amountRule = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: 1_000_000 } });
      const blacklistRule = makeRule({
        ruleType: "blacklisted_phone",
        config: { numbers: ["+237600000000"] },
      });
      (pool.query as jest.fn).mockResolvedValueOnce({
        rows: [toDbRow(amountRule), toDbRow(blacklistRule)],
      });
      (redisClient.get as jest.fn).mockResolvedValue(null);

      const outcome = await service.screenTransaction(
        makeInput({ amount: 100_000, phoneNumber: "+237699887766" }),
      );

      expect(outcome.shouldFlag).toBe(false);
      expect(outcome.matchedRules).toHaveLength(0);
      expect(outcome.allEvaluations).toHaveLength(2);
    });
  });

  // ── result persistence ─────────────────────────────────────────────────────

  describe("result persistence", () => {
    it("calls createBulk with one result per evaluated rule", async () => {
      const rule = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: 500_000 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });

      await service.screenTransaction(makeInput({ amount: 1_000_000 }), "tx-real-id");

      // Allow fire-and-forget microtasks to flush
      await flushPromises();

      expect(mockResultModel.createBulk).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            transactionId: "tx-real-id",
            ruleId: rule.id,
            ruleType: "amount_threshold",
            triggered: true,
          }),
        ]),
      );
    });

    it("persists non-triggered results as well (all evaluations logged)", async () => {
      const rule = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: 1_000_000 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });

      // Amount below threshold → not triggered
      await service.screenTransaction(makeInput({ amount: 100_000 }), "tx-real-id");
      await flushPromises();

      expect(mockResultModel.createBulk).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            transactionId: "tx-real-id",
            triggered: false,
          }),
        ]),
      );
    });

    it("does not throw when createBulk fails (fire-and-forget error isolation)", async () => {
      const rule = makeRule({ ruleType: "amount_threshold", config: { threshold_xaf: 500_000 } });
      (pool.query as jest.fn).mockResolvedValueOnce({ rows: [toDbRow(rule)] });
      mockResultModel.createBulk.mockRejectedValueOnce(new Error("DB write failed"));

      // Should not throw
      await expect(
        service.screenTransaction(makeInput({ amount: 1_000_000 })),
      ).resolves.not.toThrow();
    });
  });

  // ── incrementVelocityCounters ──────────────────────────────────────────────

  describe("incrementVelocityCounters()", () => {
    it("increments Redis counter for each provided window", async () => {
      (redisClient.incr as jest.fn)
        .mockResolvedValueOnce(1)  // first window
        .mockResolvedValueOnce(2); // second window
      (redisClient.expire as jest.fn).mockResolvedValue(1);

      const result = await service.incrementVelocityCounters("+237699887766", [3600, 86400]);

      expect(redisClient.incr).toHaveBeenCalledTimes(2);
      expect(result[3600]).toBe(1);
      expect(result[86400]).toBe(2);
    });

    it("sets TTL on first increment (count === 1)", async () => {
      (redisClient.incr as jest.fn).mockResolvedValue(1);
      (redisClient.expire as jest.fn).mockResolvedValue(1);

      await service.incrementVelocityCounters("+237699887766", [3600]);

      expect(redisClient.expire).toHaveBeenCalledWith(expect.any(String), 3600);
    });

    it("does NOT reset TTL on subsequent increments (count > 1)", async () => {
      (redisClient.incr as jest.fn).mockResolvedValue(3); // not the first

      await service.incrementVelocityCounters("+237699887766", [3600]);

      expect(redisClient.expire).not.toHaveBeenCalled();
    });

    it("returns 0 for a window when Redis incr throws", async () => {
      (redisClient.incr as jest.fn).mockRejectedValueOnce(new Error("Redis error"));

      const result = await service.incrementVelocityCounters("+237699887766", [3600]);

      expect(result[3600]).toBe(0);
    });

    it("returns empty object for empty window list", async () => {
      const result = await service.incrementVelocityCounters("+237699887766", []);

      expect(result).toEqual({});
      expect(redisClient.incr).not.toHaveBeenCalled();
    });
  });

  // ── invalidateRuleCache ────────────────────────────────────────────────────

  describe("invalidateRuleCache()", () => {
    it("forces a fresh DB query on next loadRules()", async () => {
      (pool.query as jest.fn).mockResolvedValue({ rows: [] });

      await service.loadRules();     // populates cache
      service.invalidateRuleCache(); // invalidates
      await service.loadRules();     // should re-query

      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });
});

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Convert an AmlRule object back to the raw DB row shape expected by loadRules(). */
function toDbRow(rule: AmlRule) {
  return {
    id: rule.id,
    rule_type: rule.ruleType,
    name: rule.name,
    description: rule.description,
    config: rule.config,
    enabled: rule.enabled,
  };
}

/** Flush all pending microtasks / resolved promises. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
