/**
 * API tests for the shared pagination parser across list endpoints
 * (contacts, fraud alerts, AML audit alerts).
 *
 * Covers the shared maximum page size (oversized `limit` is clamped, never
 * forwarded to SQL) and stable cursor semantics (malformed cursors are
 * rejected with 400 instead of being ignored or passed through to queries).
 */

import request from "supertest";
import express from "express";
import { createCursor } from "../../utils/pagination";

const mockListByUser = jest.fn();
const mockFraudList = jest.fn();
const mockFraudFindByUserId = jest.fn();
const mockAmlList = jest.fn();

jest.mock("../../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.jwtUser = { userId: "user-1", role: "user" };
    req.user = { id: "user-1", role: "user" };
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "user-1", role: "user" };
    next();
  },
}));

jest.mock("../../middleware/rbac", () => ({
  authorizeObj: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../models/contact", () => ({
  ContactModel: jest.fn().mockImplementation(() => ({
    listByUser: mockListByUser,
  })),
}));

jest.mock("../../models/fraudAlert", () => ({
  FraudAlertModel: jest.fn().mockImplementation(() => ({
    list: mockFraudList,
    findByUserId: mockFraudFindByUserId,
  })),
}));

jest.mock("../../models/amlAlert", () => ({
  AMLAlertModel: jest.fn().mockImplementation(() => ({
    list: mockAmlList,
  })),
}));

jest.mock("../../models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../models/users", () => ({
  UserModel: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../services/fraud", () => ({
  fraudService: { getReviewQueue: jest.fn().mockReturnValue([]) },
}));

import { contactsRoutes } from "../contacts";
import { fraudRoutes } from "../fraud";
import { auditRoutes } from "../audit";

function errorHandler(
  err: any,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) {
  const status = err.statusCode ?? err.status ?? 500;
  res.status(status).json({ error: err.message, details: err.details });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/contacts", contactsRoutes);
  app.use("/api/fraud", fraudRoutes);
  app.use("/api/audit", auditRoutes);
  app.use(errorHandler);
  return app;
}

const emptyFraudPage = {
  alerts: [],
  total: 0,
  flaggedCount: 0,
  hasMore: false,
};

const emptyAmlPage = {
  alerts: [],
  total: 0,
  pendingReview: 0,
  hasMore: false,
};

beforeEach(() => {
  mockListByUser.mockReset().mockResolvedValue({ contacts: [], nextCursor: undefined });
  mockFraudList.mockReset().mockResolvedValue(emptyFraudPage);
  mockFraudFindByUserId.mockReset().mockResolvedValue(emptyFraudPage);
  mockAmlList.mockReset().mockResolvedValue(emptyAmlPage);
});

describe("GET /api/contacts (shared pagination)", () => {
  it("clamps an oversized limit to the shared maximum page size", async () => {
    const res = await request(createApp()).get("/api/contacts?limit=100000");

    expect(res.status).toBe(200);
    expect(mockListByUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("rejects a malformed cursor with 400 and never queries the model", async () => {
    const garbage = Buffer.from("garbage").toString("base64");
    const res = await request(createApp()).get(
      `/api/contacts?after=${encodeURIComponent(garbage)}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid cursor");
    expect(mockListByUser).not.toHaveBeenCalled();
  });

  it("rejects providing both before and after with 400", async () => {
    const res = await request(createApp()).get(
      "/api/contacts?before=a&after=b",
    );

    expect(res.status).toBe(400);
    expect(mockListByUser).not.toHaveBeenCalled();
  });

  it("passes a decoded opaque cursor to the model", async () => {
    const cursor = createCursor("2026-03-27T11:46:00.000Z", "contact-7");
    const res = await request(createApp()).get(
      `/api/contacts?after=${encodeURIComponent(cursor)}&limit=10`,
    );

    expect(res.status).toBe(200);
    expect(mockListByUser).toHaveBeenCalledWith("user-1", {
      limit: 10,
      cursor: { v: 1, t: "2026-03-27T11:46:00.000Z", id: "contact-7" },
      search: undefined,
    });
  });
});

describe("GET /api/fraud/alerts (shared pagination)", () => {
  it("clamps an oversized limit to the shared maximum page size", async () => {
    const res = await request(createApp()).get("/api/fraud/alerts?limit=5000");

    expect(res.status).toBe(200);
    expect(mockFraudList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("rejects a malformed cursor with 400 and never queries the model", async () => {
    const garbage = Buffer.from("garbage").toString("base64");
    const res = await request(createApp()).get(
      `/api/fraud/alerts?after=${encodeURIComponent(garbage)}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid cursor");
    expect(mockFraudList).not.toHaveBeenCalled();
  });

  it("accepts a valid opaque cursor", async () => {
    const cursor = createCursor("2026-03-27T11:46:00.000Z", "alert-1");
    const res = await request(createApp()).get(
      `/api/fraud/alerts?after=${encodeURIComponent(cursor)}`,
    );

    expect(res.status).toBe(200);
    expect(mockFraudList).toHaveBeenCalledWith(
      expect.objectContaining({ after: cursor }),
    );
  });
});

describe("GET /api/fraud/history/:userId (shared pagination)", () => {
  it("clamps an oversized limit", async () => {
    const res = await request(createApp()).get(
      "/api/fraud/history/user-42?limit=9999",
    );

    expect(res.status).toBe(200);
    expect(mockFraudFindByUserId).toHaveBeenCalledWith("user-42", 100, 0);
  });
});

describe("GET /api/audit/aml/alerts (shared pagination)", () => {
  it("clamps an oversized limit to the shared maximum page size", async () => {
    const res = await request(createApp()).get(
      "/api/audit/aml/alerts?limit=100000",
    );

    expect(res.status).toBe(200);
    expect(mockAmlList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("rejects a malformed cursor with 400 and never queries the model", async () => {
    const garbage = Buffer.from("garbage").toString("base64");
    const res = await request(createApp()).get(
      `/api/audit/aml/alerts?after=${encodeURIComponent(garbage)}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid cursor");
    expect(mockAmlList).not.toHaveBeenCalled();
  });

  it("rejects a malformed before cursor with 400", async () => {
    const garbage = Buffer.from("garbage").toString("base64");
    const res = await request(createApp()).get(
      `/api/audit/aml/alerts?before=${encodeURIComponent(garbage)}`,
    );

    expect(res.status).toBe(400);
    expect(mockAmlList).not.toHaveBeenCalled();
  });

  it("passes a valid opaque cursor through to the model", async () => {
    const cursor = createCursor("2026-03-27T11:46:00.000Z", "aml-1");
    const res = await request(createApp()).get(
      `/api/audit/aml/alerts?after=${encodeURIComponent(cursor)}&limit=25`,
    );

    expect(res.status).toBe(200);
    expect(mockAmlList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25, after: cursor }),
    );
  });
});
