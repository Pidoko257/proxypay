import express from "express";
import request from "supertest";

const mockAddSyncJob = jest.fn();
const mockGetSyncJobById = jest.fn();
const mockGetSyncQueueStats = jest.fn();

jest.mock("../../middleware/auth", () => ({
  authenticateToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.jwtUser = { userId: req.header("x-user-id") ?? "user-1" } as any;
    next();
  },
}));

jest.mock("../../middleware/rbac", () => ({
  requirePermission:
    (permission: string) =>
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (permission !== "admin:system" || req.header("x-role") !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }
      next();
    },
}));

jest.mock("../../queue/syncQueue", () => ({
  addSyncJob: mockAddSyncJob,
  getSyncJobById: mockGetSyncJobById,
  getSyncQueueStats: mockGetSyncQueueStats,
}));

import { accountingRoutes } from "../accounting";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/accounting", accountingRoutes);
  return app;
}

describe("accounting sync routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stores the authenticated user ID with an enqueued job", async () => {
    mockAddSyncJob.mockResolvedValue({ id: "job-1" });

    const response = await request(buildApp())
      .post("/api/accounting/sync")
      .send({
        transactionId: "transaction-1",
        platform: "xero",
        payload: { referenceNumber: "ref-1" },
      });

    expect(response.status).toBe(202);
    expect(mockAddSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("does not return another user's job details", async () => {
    const job = {
      id: "job-1",
      data: {
        userId: "user-2",
        syncId: "sync-1",
        transactionId: "transaction-1",
        platform: "xero",
      },
      getState: jest.fn(),
    };
    mockGetSyncJobById.mockResolvedValue(job);

    const response = await request(buildApp())
      .get("/api/accounting/sync/job-1")
      .set("x-user-id", "user-1");

    expect(response.status).toBe(404);
    expect(response.body).not.toHaveProperty("data");
    expect(job.getState).not.toHaveBeenCalled();
  });

  it("allows the owner to read their job status", async () => {
    const job = {
      id: "job-1",
      data: {
        userId: "user-1",
        syncId: "sync-1",
        transactionId: "transaction-1",
        platform: "xero",
      },
      getState: jest.fn().mockResolvedValue("completed"),
      returnvalue: undefined,
      attemptsMade: 1,
    };
    mockGetSyncJobById.mockResolvedValue(job);

    const response = await request(buildApp()).get(
      "/api/accounting/sync/job-1",
    );

    expect(response.status).toBe(200);
    expect(response.body.data.transactionId).toBe("transaction-1");
    expect(job.getState).toHaveBeenCalled();
  });

  it("requires admin permission to view queue statistics", async () => {
    mockGetSyncQueueStats.mockResolvedValue({ waiting: 0, active: 0 });

    const denied = await request(buildApp()).get("/api/accounting/sync/stats");
    expect(denied.status).toBe(403);
    expect(mockGetSyncQueueStats).not.toHaveBeenCalled();

    const allowed = await request(buildApp())
      .get("/api/accounting/sync/stats")
      .set("x-role", "admin");
    expect(allowed.status).toBe(200);
    expect(mockGetSyncQueueStats).toHaveBeenCalledTimes(1);
  });
});
