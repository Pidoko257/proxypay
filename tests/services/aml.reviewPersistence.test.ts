/**
 * AMLService.reviewAlert must persist review decisions to aml_alerts so they
 * survive a pod restart, rather than only mutating the in-memory buffer.
 */

const mockReview = jest.fn();
const mockCreate = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock("../../src/services/sanctionService", () => ({
  sanctionService: { searchSanctions: jest.fn(async () => []) },
}));

jest.mock("../../src/models/amlAlert", () => ({
  AMLAlertModel: jest.fn().mockImplementation(() => ({
    review: mockReview,
    create: mockCreate,
  })),
}));

import { AMLAlert, AMLService } from "../../src/services/aml";

const persistedAlert = (overrides: Partial<AMLAlert> = {}): AMLAlert => ({
  id: "alert-1",
  transactionId: "txn-1",
  userId: "user-1",
  severity: "high",
  status: "reviewed",
  ruleHits: [],
  reasons: [],
  createdAt: "2026-03-26T12:00:00.000Z",
  updatedAt: "2026-03-26T13:00:00.000Z",
  reviewedAt: "2026-03-26T13:00:00.000Z",
  reviewedBy: "reviewer-uuid",
  reviewNotes: "Source of funds verified",
  ...overrides,
});

describe("AMLService.reviewAlert persistence", () => {
  let service: AMLService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    service = new AMLService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("writes the review decision to the database", async () => {
    const stored = persistedAlert();
    mockReview.mockResolvedValue(stored);

    const result = await service.reviewAlert("alert-1", {
      status: "reviewed",
      reviewedBy: "reviewer-uuid",
      reviewNotes: "Source of funds verified",
    });

    expect(mockReview).toHaveBeenCalledWith(
      "alert-1",
      {
        status: "reviewed",
        reviewedBy: "reviewer-uuid",
        reviewNotes: "Source of funds verified",
      },
      "reviewer-uuid",
    );
    expect(result).toEqual(stored);
  });

  it("returns the DB-backed alert even when it is not in the in-memory buffer (e.g. after a restart)", async () => {
    mockReview.mockResolvedValue(persistedAlert({ status: "dismissed" }));

    const result = await service.reviewAlert("alert-1", {
      status: "dismissed",
      reviewedBy: "reviewer-uuid",
    });

    expect(result?.status).toBe("dismissed");
    expect(service.getAlerts()).toHaveLength(0);
  });

  it("returns null when the alert exists neither in the database nor in memory", async () => {
    mockReview.mockResolvedValue(null);

    const result = await service.reviewAlert("missing", {
      status: "reviewed",
      reviewedBy: "reviewer-uuid",
    });

    expect(result).toBeNull();
  });

  it("propagates database errors instead of silently keeping the review in memory", async () => {
    mockReview.mockRejectedValue(new Error("connection refused"));

    await expect(
      service.reviewAlert("alert-1", {
        status: "reviewed",
        reviewedBy: "reviewer-uuid",
      }),
    ).rejects.toThrow("connection refused");
  });

  it("falls back to the in-memory buffer for alerts that never reached the database", async () => {
    // Creation fails -> alert lives only in the in-memory fallback buffer.
    mockCreate.mockRejectedValue(new Error("db down"));
    const flagged = await service.evaluateTransaction(
      {
        id: "txn-1",
        userId: "user-1",
        type: "deposit",
        amount: 10_000_000,
        createdAt: new Date(),
      },
      [],
    );
    const alertId = flagged.alert!.id;
    mockReview.mockResolvedValue(null);

    const result = await service.reviewAlert(alertId, {
      status: "reviewed",
      reviewedBy: "reviewer-uuid",
    });

    expect(result?.status).toBe("reviewed");
    expect(service.getAlerts({ status: "reviewed" })).toHaveLength(1);
  });
});
