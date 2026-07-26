import express, { Request, Response, NextFunction } from "express";
import request from "supertest";

jest.mock("../../src/controllers/transactionController", () => ({
  updateAdminNotesHandler: jest.fn(),
  refundTransactionHandler: jest.fn(),
}));

jest.mock("../../src/queue/transactionQueue", () => ({
  getQueueStats: jest.fn().mockResolvedValue({
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    isPaused: false,
  }),
}));

jest.mock("../../src/config/database", () => ({
  checkReplicaHealth: jest.fn().mockResolvedValue([]),
  pool: { query: jest.fn() },
}));

const mockGetAllQueueMetrics = jest.fn();
const mockGetQueueFailedJobs = jest.fn();

jest.mock("../../src/queue/observability", () => ({
  getAllQueueMetrics: (...args: unknown[]) => mockGetAllQueueMetrics(...args),
  getQueueFailedJobs: (...args: unknown[]) => mockGetQueueFailedJobs(...args),
}));

import { adminRoutes } from "../../src/routes/admin";
import { errorHandler } from "../../src/middleware/errorHandler";

describe("Admin Routes - Queue Observability", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.query.mockAdmin === "true") {
        (req as any).user = { id: "admin-1", role: "admin" };
      } else if (req.query.mockUser === "true") {
        (req as any).user = { id: "user-1", role: "user" };
      }
      next();
    });

    app.use("/api/admin", adminRoutes);
    app.use(errorHandler);
  });

  describe("GET /api/admin/queues", () => {
    it("returns 403 when caller is not an admin", async () => {
      const response = await request(app)
        .get("/api/admin/queues")
        .query({ mockUser: "true" });

      expect(response.status).toBe(403);
      expect(mockGetAllQueueMetrics).not.toHaveBeenCalled();
    });

    it("returns 403 when caller is unauthenticated", async () => {
      const response = await request(app).get("/api/admin/queues");
      expect(response.status).toBe(403);
    });

    it("returns queue metrics for an authenticated admin", async () => {
      mockGetAllQueueMetrics.mockResolvedValue([
        { name: "accounting-sync", waiting: 1, active: 0, completed: 10, failed: 2, delayed: 0 },
        { name: "account-merge", waiting: 0, active: 0, completed: 5, failed: 0, delayed: 0 },
      ]);

      const response = await request(app)
        .get("/api/admin/queues")
        .query({ mockAdmin: "true" });

      expect(response.status).toBe(200);
      expect(response.body.queues).toHaveLength(2);
      expect(response.body.queues[0]).toMatchObject({
        name: "accounting-sync",
        waiting: 1,
        failed: 2,
      });
      expect(response.body).toHaveProperty("timestamp");
    });

    it("returns 500 when the queue backend fails", async () => {
      mockGetAllQueueMetrics.mockRejectedValue(new Error("redis down"));

      const response = await request(app)
        .get("/api/admin/queues")
        .query({ mockAdmin: "true" });

      expect(response.status).toBe(500);
    });
  });

  describe("GET /api/admin/queues/:name/failed", () => {
    it("returns 403 when caller is not an admin", async () => {
      const response = await request(app)
        .get("/api/admin/queues/accounting-sync/failed")
        .query({ mockUser: "true" });

      expect(response.status).toBe(403);
      expect(mockGetQueueFailedJobs).not.toHaveBeenCalled();
    });

    it("returns failed jobs for a known queue", async () => {
      mockGetQueueFailedJobs.mockResolvedValue([
        {
          id: "job-1",
          name: "sync-operation",
          failedReason: "Provider timeout",
          stacktrace: ["Error: timeout"],
          attemptsMade: 3,
          timestamp: 1000,
          failedAt: 1500,
        },
      ]);

      const response = await request(app)
        .get("/api/admin/queues/accounting-sync/failed")
        .query({ mockAdmin: "true" });

      expect(response.status).toBe(200);
      expect(response.body.queue).toBe("accounting-sync");
      expect(response.body.count).toBe(1);
      expect(response.body.jobs[0]).toMatchObject({
        id: "job-1",
        failedReason: "Provider timeout",
      });
      expect(mockGetQueueFailedJobs).toHaveBeenCalledWith("accounting-sync");
    });

    it("returns 404 for an unknown queue name", async () => {
      const notFoundError = new Error('Queue "bogus" not found') as Error & {
        code: string;
        statusCode: number;
      };
      notFoundError.code = "NOT_FOUND";
      notFoundError.statusCode = 404;
      mockGetQueueFailedJobs.mockRejectedValue(notFoundError);

      const response = await request(app)
        .get("/api/admin/queues/bogus/failed")
        .query({ mockAdmin: "true" });

      expect(response.status).toBe(404);
    });
  });
});
