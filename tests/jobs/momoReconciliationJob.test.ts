/**
 * Tests for the MoMo reconciliation job.
 * Database and MobileMoneyService are fully mocked.
 */

jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn() },
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

jest.mock("../../src/models/transaction", () => {
  const TransactionStatus = {
    Pending: "pending",
    Completed: "completed",
    Failed: "failed",
    Review: "review",
    Cancelled: "cancelled",
    Dispute: "dispute",
    Reversed: "reversed",
    ClawedBack: "clawed_back",
  };
  return {
    TransactionStatus,
    TransactionModel: jest.fn().mockImplementation(() => ({
      updateStatus: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

jest.mock("../../src/services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn(),
}));

import { pool } from "../../src/config/database";
import { runMomoReconciliationJob } from "../../src/jobs/momoReconciliationJob";
import { TransactionStatus, TransactionModel } from "../../src/models/transaction";

const mockPoolQuery = pool.query as jest.Mock;
const MockTransactionModel = TransactionModel as jest.MockedClass<typeof TransactionModel>;

function makeMomoService(statusMap: Record<string, string>) {
  return {
    getTransactionStatus: jest.fn(async (_provider: string, reference: string) => ({
      success: true,
      data: { status: statusMap[reference] ?? "unknown" },
    })),
  } as any;
}

describe("runMomoReconciliationJob", () => {
  let mockUpdateStatus: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    // Re-setup TransactionModel mock after resetAllMocks
    mockUpdateStatus = jest.fn().mockResolvedValue(undefined);
    MockTransactionModel.mockImplementation(() => ({ updateStatus: mockUpdateStatus } as any));
  });

  it("returns zeros when no stale transactions exist", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const summary = await runMomoReconciliationJob(makeMomoService({}));

    expect(summary).toEqual({ checked: 0, updated: 0, flagged: 0, errors: 0 });
  });

  it("queries transactions in pending state older than 10 minutes", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runMomoReconciliationJob(makeMomoService({}));

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("status = $1");
    expect(sql).toContain("10 minutes");
    expect(params).toEqual([TransactionStatus.Pending]);
  });

  it("marks transaction completed when MoMo reports completed", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: "tx1", reference_number: "REF1", provider: "mtn", status: "pending", created_at: new Date() }],
    });

    const summary = await runMomoReconciliationJob(makeMomoService({ REF1: "completed" }));

    expect(summary.updated).toBe(1);
    expect(summary.flagged).toBe(0);
    expect(mockUpdateStatus).toHaveBeenCalledWith("tx1", TransactionStatus.Completed);
  });

  it("marks transaction failed when MoMo reports failed", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: "tx2", reference_number: "REF2", provider: "airtel", status: "pending", created_at: new Date() }],
    });

    const summary = await runMomoReconciliationJob(makeMomoService({ REF2: "failed" }));

    expect(summary.updated).toBe(1);
    expect(summary.errors).toBe(0);
    expect(mockUpdateStatus).toHaveBeenCalledWith("tx2", TransactionStatus.Failed);
  });

  it("flags for review when MoMo completed but local status is failed (discrepancy)", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: "tx3", reference_number: "REF3", provider: "mtn", status: "failed", created_at: new Date() }],
    });

    const summary = await runMomoReconciliationJob(makeMomoService({ REF3: "completed" }));

    expect(summary.flagged).toBe(1);
    expect(summary.updated).toBe(0);
    expect(mockUpdateStatus).toHaveBeenCalledWith("tx3", TransactionStatus.Review);
  });

  it("increments errors when provider status check returns no data", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: "tx4", reference_number: "REF4", provider: "mtn", status: "pending", created_at: new Date() }],
    });

    const service = {
      getTransactionStatus: jest.fn().mockResolvedValue({ success: false, data: null }),
    } as any;

    const summary = await runMomoReconciliationJob(service);

    expect(summary.errors).toBe(1);
    expect(summary.updated).toBe(0);
  });

  it("handles exceptions from provider and increments errors without throwing", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: "tx5", reference_number: "REF5", provider: "mtn", status: "pending", created_at: new Date() }],
    });

    const service = {
      getTransactionStatus: jest.fn().mockRejectedValue(new Error("network error")),
    } as any;

    await expect(runMomoReconciliationJob(service)).resolves.toMatchObject({ errors: 1 });
  });

  it("leaves transaction alone when MoMo still shows pending", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: "tx6", reference_number: "REF6", provider: "mtn", status: "pending", created_at: new Date() }],
    });

    const summary = await runMomoReconciliationJob(makeMomoService({ REF6: "pending" }));

    expect(summary.updated).toBe(0);
    expect(summary.flagged).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.checked).toBe(1);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it("processes multiple transactions and counts correctly", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: "a", reference_number: "A", provider: "mtn", status: "pending", created_at: new Date() },
        { id: "b", reference_number: "B", provider: "mtn", status: "failed", created_at: new Date() },
        { id: "c", reference_number: "C", provider: "mtn", status: "pending", created_at: new Date() },
      ],
    });

    // A: pending → completed (updated), B: failed + momo completed (flagged), C: pending → failed (updated)
    const summary = await runMomoReconciliationJob(
      makeMomoService({ A: "completed", B: "completed", C: "failed" }),
    );

    expect(summary.checked).toBe(3);
    expect(summary.updated).toBe(2);
    expect(summary.flagged).toBe(1);
    expect(summary.errors).toBe(0);
  });
});
