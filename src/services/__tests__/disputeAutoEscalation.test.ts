/**
 * Test suite for DisputeAutoEscalationService
 *
 * Tests cover:
 *  - Rule evaluation based on amount and age
 *  - CRUD operations for rules
 *  - Escalation history tracking
 *  - Cache invalidation
 */

import {
  DisputeAutoEscalationService,
  AutoEscalationRule,
  EscalationEvaluation,
} from "../disputeAutoEscalationService";
import { Dispute, DisputePriority } from "../../models/dispute";
import { queryRead, queryWrite } from "../../config/database";

// Mock database queries
jest.mock("../../config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
  pool: {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRule = (overrides: Partial<AutoEscalationRule> = {}): AutoEscalationRule => ({
  id: "rule-1",
  name: "high-value-escalation",
  enabled: true,
  minAmount: 500000,
  maxAmount: undefined,
  ageHoursThreshold: 24,
  currentPriority: "medium",
  newPriority: "high",
  maxEscalationsPerDispute: 5,
  description: "Escalate high-value disputes after 24 hours",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeDispute = (overrides: Partial<Dispute> = {}): Dispute => ({
  id: "dispute-1",
  transactionId: "txn-1",
  reason: "wrong amount",
  status: "open",
  assignedTo: null,
  resolution: null,
  reportedBy: "user-1",
  priority: "medium",
  category: null,
  slaDueDate: null,
  slaWarningSent: false,
  internalNotes: null,
  lastAutoEscalatedAt: null,
  createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 48 hours ago
  updatedAt: new Date(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DisputeAutoEscalationService", () => {
  let service: DisputeAutoEscalationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DisputeAutoEscalationService();
  });

  // -------------------------------------------------------------------------
  // evaluateDispute()
  // -------------------------------------------------------------------------

  describe("evaluateDispute()", () => {
    it("returns no match when no rules apply", async () => {
      const dispute = makeDispute();
      const transactionAmount = 100000; // Below min amount

      (queryRead as jest.Mock).mockResolvedValue({
        rows: [makeRule()],
      });

      (queryWrite as jest.Mock).mockResolvedValue({
        rows: [{ count: "0" }],
      });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(false);
      expect(result.matchingRules).toHaveLength(0);
      expect(result.recommendedPriority).toBeUndefined();
    });

    it("matches rule with amount in range", async () => {
      const dispute = makeDispute();
      const transactionAmount = 750000; // Within range

      const rule = makeRule({
        minAmount: 500000,
        maxAmount: 1000000,
        ageHoursThreshold: 24,
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule] }) // loadRules
        .mockResolvedValueOnce({ rows: [{ count: "0" }] }); // getEscalationCount

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(true);
      expect(result.matchingRules).toHaveLength(1);
      expect(result.recommendedPriority).toBe("high");
    });

    it("matches rule with age threshold", async () => {
      const dispute = makeDispute({
        createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000), // 30 hours old
      });
      const transactionAmount = 750000;

      const rule = makeRule({
        minAmount: 500000,
        ageHoursThreshold: 24,
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(true);
      expect(result.disputeAgeHours).toBeGreaterThan(24);
    });

    it("does not match rule if age is below threshold", async () => {
      const dispute = makeDispute({
        createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000), // 10 hours old
      });
      const transactionAmount = 750000;

      const rule = makeRule({
        minAmount: 500000,
        ageHoursThreshold: 24,
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(false);
    });

    it("matches rule with current priority check", async () => {
      const dispute = makeDispute({ priority: "medium" });
      const transactionAmount = 750000;

      const rule = makeRule({
        minAmount: 500000,
        ageHoursThreshold: 24,
        currentPriority: "medium",
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(true);
    });

    it("does not match rule if current priority doesn't match", async () => {
      const dispute = makeDispute({ priority: "low" });
      const transactionAmount = 750000;

      const rule = makeRule({
        minAmount: 500000,
        ageHoursThreshold: 24,
        currentPriority: "medium",
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(false);
    });

    it("respects max escalations per dispute", async () => {
      const dispute = makeDispute();
      const transactionAmount = 750000;

      const rule = makeRule({
        minAmount: 500000,
        ageHoursThreshold: 24,
        maxEscalationsPerDispute: 2,
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule] })
        .mockResolvedValueOnce({ rows: [{ count: "3" }] }); // Already escalated 3 times

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(false);
    });

    it("selects highest priority when multiple rules match", async () => {
      const dispute = makeDispute();
      const transactionAmount = 1000000; // High value

      const rule1 = makeRule({
        id: "rule-1",
        minAmount: 500000,
        newPriority: "high",
        ageHoursThreshold: 12,
      });

      const rule2 = makeRule({
        id: "rule-2",
        minAmount: 900000,
        newPriority: "critical",
        ageHoursThreshold: 6,
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule1, rule2] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(true);
      expect(result.matchingRules).toHaveLength(2);
      expect(result.recommendedPriority).toBe("critical");
    });
  });

  // -------------------------------------------------------------------------
  // CRUD Operations
  // -------------------------------------------------------------------------

  describe("createRule()", () => {
    it("creates a new auto-escalation rule", async () => {
      const newRule = makeRule();

      (queryWrite as jest.Mock).mockResolvedValue({
        rows: [newRule],
      });

      const created = await service.createRule({
        name: newRule.name,
        enabled: newRule.enabled,
        minAmount: newRule.minAmount,
        maxAmount: newRule.maxAmount,
        ageHoursThreshold: newRule.ageHoursThreshold,
        currentPriority: newRule.currentPriority,
        newPriority: newRule.newPriority,
        maxEscalationsPerDispute: newRule.maxEscalationsPerDispute,
        description: newRule.description,
      });

      expect(created).toBeDefined();
      expect(created.name).toBe(newRule.name);
      expect(created.newPriority).toBe("high");
    });
  });

  describe("getAllRules()", () => {
    it("returns all enabled rules", async () => {
      const rules = [
        makeRule({ id: "rule-1", name: "high-value" }),
        makeRule({ id: "rule-2", name: "old-disputes" }),
      ];

      (queryRead as jest.Mock).mockResolvedValue({
        rows: rules,
      });

      const result = await service.getAllRules();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("high-value");
      expect(result[1].name).toBe("old-disputes");
    });
  });

  describe("updateRule()", () => {
    it("updates a rule by ID", async () => {
      const updatedRule = makeRule({
        newPriority: "critical",
      });

      (queryWrite as jest.Mock).mockResolvedValue({
        rows: [updatedRule],
      });

      const result = await service.updateRule("rule-1", {
        newPriority: "critical",
      });

      expect(result.newPriority).toBe("critical");
    });
  });

  describe("deleteRule()", () => {
    it("deletes a rule by ID", async () => {
      (queryWrite as jest.Mock).mockResolvedValue({
        rowCount: 1,
      });

      await service.deleteRule("rule-1");

      expect(queryWrite).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // History Tracking
  // -------------------------------------------------------------------------

  describe("recordAutoEscalation()", () => {
    it("records an escalation event in history", async () => {
      (queryWrite as jest.Mock).mockResolvedValue({
        rowCount: 1,
      });

      await service.recordAutoEscalation(
        "dispute-1",
        "rule-1",
        "medium",
        "high",
        500000,
        24.5,
      );

      expect(queryWrite).toHaveBeenCalled();
      const call = (queryWrite as jest.Mock).mock.calls[0];
      expect(call[0]).toContain("dispute_auto_escalation_history");
    });
  });

  describe("getAutoEscalationHistory()", () => {
    it("returns escalation history for a dispute", async () => {
      const history = [
        {
          id: "hist-1",
          dispute_id: "dispute-1",
          old_priority: "medium",
          new_priority: "high",
          created_at: new Date().toISOString(),
        },
      ];

      (queryRead as jest.Mock).mockResolvedValue({
        rows: history,
      });

      const result = await service.getAutoEscalationHistory("dispute-1");

      expect(result).toHaveLength(1);
      expect(result[0].new_priority).toBe("high");
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles amount boundary - exactly min amount", async () => {
      const dispute = makeDispute();
      const transactionAmount = 500000; // Exactly at min

      const rule = makeRule({
        minAmount: 500000,
        ageHoursThreshold: 24,
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(true);
    });

    it("handles amount boundary - exactly max amount", async () => {
      const dispute = makeDispute();
      const transactionAmount = 1000000; // Exactly at max

      const rule = makeRule({
        minAmount: 500000,
        maxAmount: 1000000,
        ageHoursThreshold: 24,
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(true);
    });

    it("handles unbounded max amount (undefined)", async () => {
      const dispute = makeDispute();
      const transactionAmount = 10000000; // Very high

      const rule = makeRule({
        minAmount: 500000,
        maxAmount: undefined,
        ageHoursThreshold: 24,
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(true);
    });

    it("handles age boundary - exactly at threshold", async () => {
      const dispute = makeDispute({
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // Exactly 24 hours
      });
      const transactionAmount = 750000;

      const rule = makeRule({
        minAmount: 500000,
        ageHoursThreshold: 24,
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(true);
    });

    it("handles disabled rules", async () => {
      const dispute = makeDispute();
      const transactionAmount = 750000;

      const rule = makeRule({
        enabled: false,
      });

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: [rule] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.shouldEscalate).toBe(false);
    });

    it("handles multiple rules with different priorities", async () => {
      const dispute = makeDispute();
      const transactionAmount = 750000;

      const rules = [
        makeRule({
          id: "rule-low",
          newPriority: "medium",
          ageHoursThreshold: 48,
        }),
        makeRule({
          id: "rule-high",
          newPriority: "critical",
          minAmount: 700000,
          ageHoursThreshold: 12,
        }),
      ];

      (queryRead as jest.Mock)
        .mockResolvedValueOnce({ rows: rules })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.evaluateDispute(dispute, transactionAmount);

      expect(result.matchingRules.length).toBeGreaterThan(0);
      // Should pick the highest priority
      expect(result.recommendedPriority).toBe("critical");
    });
  });
});
