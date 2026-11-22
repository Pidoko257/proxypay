jest.mock("../../src/config/database", () => ({ pool: { query: jest.fn() } }));
jest.mock("../../src/queue/sarGenerationQueue", () => ({
  enqueueSarGeneration: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../src/services/sanctionService", () => ({
  sanctionService: { searchSanctions: jest.fn().mockResolvedValue([]) },
}));

import { AMLAlert, AMLService, AMLTransactionRecord } from "../../src/services/aml";
import { AMLAlertModel } from "../../src/models/amlAlert";
import { enqueueSarGeneration } from "../../src/queue/sarGenerationQueue";

/**
 * Minimal stand-in for the aml_alerts table so the service can be exercised
 * end-to-end without PostgreSQL.
 */
function createFakeModel() {
  const rows: AMLAlert[] = [];
  const model = {
    create: jest.fn(async (alert: AMLAlert) => {
      rows.push({ ...alert });
      return alert;
    }),
    findAll: jest.fn(async (filter: any = {}) =>
      rows
        .filter((a) => !filter.status || a.status === filter.status)
        .filter((a) => !filter.userId || a.userId === filter.userId)
        .filter((a) => !filter.startDate || new Date(a.createdAt) >= filter.startDate)
        .filter((a) => !filter.endDate || new Date(a.createdAt) <= filter.endDate)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    ),
    review: jest.fn(async (id: string, input: any, reviewerId: string) => {
      const row = rows.find((a) => a.id === id);
      if (!row) return null;
      Object.assign(row, {
        status: input.status,
        reviewedBy: reviewerId,
        reviewNotes: input.reviewNotes,
        reviewedAt: new Date().toISOString(),
      });
      return { ...row };
    }),
    updateEscalation: jest.fn(async () => null),
  };
  return { rows, model };
}

describe("AMLService", () => {
  let amlService: AMLService;
  let fake: ReturnType<typeof createFakeModel>;
  const now = new Date();

  beforeEach(() => {
    jest.clearAllMocks();
    fake = createFakeModel();
    amlService = new AMLService(
      {
        singleTransactionThresholdXaf: 1_000_000,
        dailyTotalThresholdXaf: 5_000_000,
        rollingWindowHours: 24,
        rapidWindowMinutes: 15,
        rapidTransactionCount: 3,
        structuringFloorXaf: 100_000,
      },
      fake.model as unknown as AMLAlertModel,
    );
  });

  const baseTx = (partial: Partial<AMLTransactionRecord> = {}): AMLTransactionRecord => ({
    id: partial.id ?? "txn-current",
    userId: partial.userId ?? "user-1",
    type: partial.type ?? "deposit",
    amount: partial.amount ?? 1000,
    createdAt: partial.createdAt ?? now,
    status: partial.status ?? "pending",
  });

  it("flags single large transaction above threshold and persists it", async () => {
    const result = await amlService.evaluateTransaction(
      baseTx({ amount: 1_200_000 }),
      [],
    );

    expect(result.flagged).toBe(true);
    expect(result.ruleHits.some((hit) => hit.rule === "single_transaction_threshold")).toBe(true);
    expect(fake.model.create).toHaveBeenCalledTimes(1);
    expect(await amlService.getPendingReviewAlerts()).toHaveLength(1);
  });

  it("enqueues SAR generation as a durable job for high-severity alerts", async () => {
    const result = await amlService.evaluateTransaction(
      baseTx({ amount: 1_200_000 }),
      [],
    );

    expect(enqueueSarGeneration).toHaveBeenCalledWith({
      userId: "user-1",
      alertId: result.alert!.id,
    });
  });

  it("throws instead of silently dropping the alert when the database fails", async () => {
    fake.model.create.mockRejectedValueOnce(new Error("db down"));

    await expect(
      amlService.evaluateTransaction(baseTx({ amount: 1_200_000 }), []),
    ).rejects.toThrow("db down");
    expect(enqueueSarGeneration).not.toHaveBeenCalled();
  });

  it("flags 24-hour aggregate amount above threshold", async () => {
    const history = [
      baseTx({
        id: "txn-1",
        amount: 3_000_000,
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      }),
      baseTx({
        id: "txn-2",
        amount: 1_600_000,
        createdAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
      }),
    ];

    const result = await amlService.evaluateTransaction(
      baseTx({ id: "txn-current", amount: 600_000 }),
      history,
    );

    expect(result.flagged).toBe(true);
    expect(result.ruleHits.some((hit) => hit.rule === "daily_total_threshold")).toBe(true);
  });

  it("flags rapid deposit and withdrawal structuring pattern", async () => {
    const history = [
      baseTx({
        id: "txn-1",
        type: "deposit",
        amount: 300_000,
        createdAt: new Date(now.getTime() - 7 * 60 * 1000),
      }),
      baseTx({
        id: "txn-2",
        type: "withdraw",
        amount: 280_000,
        createdAt: new Date(now.getTime() - 5 * 60 * 1000),
      }),
    ];

    const result = await amlService.evaluateTransaction(
      baseTx({
        id: "txn-3",
        type: "deposit",
        amount: 250_000,
        createdAt: new Date(now.getTime() - 3 * 60 * 1000),
      }),
      history,
    );

    expect(result.flagged).toBe(true);
    expect(result.ruleHits.some((hit) => hit.rule === "rapid_structuring")).toBe(true);
    expect(result.alert?.severity).toBe("medium");
    expect(enqueueSarGeneration).not.toHaveBeenCalled();
  });

  it("supports manual review workflow for generated alerts", async () => {
    const flagged = await amlService.evaluateTransaction(
      baseTx({ amount: 1_300_000 }),
      [],
    );
    expect(flagged.alert).toBeDefined();

    const reviewed = await amlService.reviewAlert(flagged.alert!.id, {
      status: "reviewed",
      reviewedBy: "compliance-analyst",
      reviewNotes: "Source of funds verified",
    });

    expect(fake.model.review).toHaveBeenCalled();
    expect(reviewed?.status).toBe("reviewed");
    expect(reviewed?.reviewedBy).toBe("compliance-analyst");
    expect(reviewed?.reviewNotes).toContain("verified");
  });

  it("generates AML report with rule and status breakdown", async () => {
    await amlService.evaluateTransaction(baseTx({ id: "txn-a", amount: 1_200_000 }), []);
    const [alert] = await amlService.getPendingReviewAlerts();
    await amlService.reviewAlert(alert.id, {
      status: "dismissed",
      reviewedBy: "compliance-team",
      reviewNotes: "False positive",
    });

    const report = await amlService.generateReport(
      new Date(now.getTime() - 24 * 60 * 60 * 1000),
      new Date(now.getTime() + 24 * 60 * 60 * 1000),
    );

    expect(report.summary.totalAlerts).toBe(1);
    expect(report.summary.dismissed).toBe(1);
    expect(report.byRule.single_transaction_threshold).toBeGreaterThanOrEqual(1);
    expect(report.daily.length).toBeGreaterThan(0);
  });
});
