import express from "express";
import request from "supertest";

const mockList = jest.fn();
const mockCount = jest.fn();

jest.mock("../../src/models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    list: mockList,
    count: mockCount,
  })),
  TransactionStatus: {
    Pending: "pending",
    Completed: "completed",
    Failed: "failed",
    Cancelled: "cancelled",
  },
}));

jest.mock("../../src/services/stellar/stellarService", () => ({
  StellarService: jest.fn(),
}));

jest.mock("../../src/services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn(),
}));

jest.mock("../../src/services/transactionLimit/transactionLimitService", () => ({
  TransactionLimitService: jest.fn(),
}));

jest.mock("../../src/services/kyc/kycService", () => ({
  KYCService: jest.fn(),
}));

jest.mock("../../src/services/aml", () => ({
  amlService: { monitorTransaction: jest.fn(), getAlerts: jest.fn() },
}));

jest.mock("../../src/services/twoFactorWithdrawalService", () => ({
  twoFactorWithdrawalService: {
    requires2FAForWithdrawal: jest.fn(),
    verifyWithdrawal2FA: jest.fn(),
  },
}));

jest.mock("../../src/stellar/trustlines", () => ({
  checkDestinationTrustline: jest.fn(),
  TrustlineError: class TrustlineError extends Error {},
}));

jest.mock("../../src/services/stellar/assetService", () => ({
  getConfiguredPaymentAsset: jest.fn(),
}));

import { getTransactionHistoryHandler } from "../../src/controllers/transactionController";
import { errorHandler } from "../../src/middleware/errorHandler";
import { createCursor } from "../../src/utils/pagination";

function createHistoryApp() {
  const app = express();
  app.get("/transactions", getTransactionHistoryHandler);
  app.use(errorHandler);
  return app;
}

describe("transaction history keyset pagination route", () => {
  beforeEach(() => {
    mockList.mockReset();
    mockCount.mockReset();
  });

  it("keeps offset semantics while avoiding count on deep pages", async () => {
    mockList.mockResolvedValue([
      { id: "tx-5000", createdAt: new Date("2026-05-01T00:00:00.000Z") },
      { id: "tx-5001", createdAt: new Date("2026-04-30T00:00:00.000Z") },
      { id: "tx-5002", createdAt: new Date("2026-04-29T00:00:00.000Z") },
    ]);

    const app = express();
    app.get("/transactions", getTransactionHistoryHandler);

    const res = await request(app)
      .get("/transactions?offset=5000&limit=2")
      .expect(200);

    expect(mockList).toHaveBeenCalledWith(
      3,
      5000,
      undefined,
      undefined,
      {
        minAmount: undefined,
        maxAmount: undefined,
        provider: undefined,
        tags: undefined,
      },
    );
    expect(mockCount).not.toHaveBeenCalled();
    expect(res.body.data.map((tx: { id: string }) => tx.id)).toEqual([
      "tx-5000",
      "tx-5001",
    ]);
    expect(res.body.pagination).toMatchObject({
      total: null,
      limit: 2,
      offset: 5000,
      hasMore: true,
    });
  });

  it("applies a valid opaque cursor and returns 200", async () => {
    mockList.mockResolvedValue([]);

    const cursor = createCursor(
      "2026-05-02T00:00:00.000Z",
      "00000000-0000-0000-0000-000000000002",
    );

    await request(createHistoryApp())
      .get(`/transactions?after=${encodeURIComponent(cursor)}`)
      .expect(200);

    expect(mockList).toHaveBeenCalledWith(
      21,
      0,
      undefined,
      undefined,
      {
        minAmount: undefined,
        maxAmount: undefined,
        provider: undefined,
        tags: undefined,
      },
      { before: undefined, after: cursor },
    );
  });

  const base64Json = (payload: unknown): string =>
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

  it.each([
    ["malformed base64", Buffer.from("garbage").toString("base64")],
    [
      "a non-UUID identifier",
      base64Json({
        v: 1,
        t: "2026-05-02T00:00:00.000Z",
        id: "tx-5000",
      }),
    ],
    [
      "an unknown cursor version",
      base64Json({
        v: 2,
        t: "2026-05-02T00:00:00.000Z",
        id: "00000000-0000-0000-0000-000000000002",
      }),
    ],
    [
      "an unexpected extra field",
      base64Json({
        v: 1,
        t: "2026-05-02T00:00:00.000Z",
        id: "00000000-0000-0000-0000-000000000002",
        extra: "unexpected",
      }),
    ],
    [
      "a timestamp outside the supported range",
      base64Json({
        v: 1,
        t: "2100-01-01T00:00:01.000Z",
        id: "00000000-0000-0000-0000-000000000002",
      }),
    ],
  ])("returns 400 for %s and never queries the database", async (_label, cursor) => {
    const res = await request(createHistoryApp()).get(
      `/transactions?after=${encodeURIComponent(cursor)}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid pagination cursor");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid `before` cursor", async () => {
    const res = await request(createHistoryApp()).get(
      `/transactions?before=${encodeURIComponent(
        Buffer.from("2026-05-02T00:00:00.000Z").toString("base64"),
      )}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid pagination cursor");
    expect(mockList).not.toHaveBeenCalled();
  });
});
