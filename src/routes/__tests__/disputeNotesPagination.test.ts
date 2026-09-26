/**
 * Route tests for cursor-paginated dispute notes (issue #622).
 *
 * The notes endpoint defaults to a 50-note page, forwards cursor/sort options
 * to the service and maps pagination failures to 400 rather than 500.
 */

import request from "supertest";
import express from "express";

const mockGetNotesPage = jest.fn();

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "user-1", role: "user" };
    next();
  },
}));

jest.mock("../../middleware/rbac", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../services/disputeS3Upload", () => ({
  uploadDisputeEvidenceToS3: jest.fn(),
  uploadMultipleDisputeEvidenceToS3: jest.fn(),
  validateDisputeEvidenceFile: jest.fn().mockReturnValue({ valid: true }),
}));

jest.mock("../../services/fileSecurityService", () => ({
  gateUpload: jest.fn(),
  linkStoredKey: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../jobs/disputeSlaJob", () => ({
  generateDisputeSlaReport: jest.fn(),
  runDisputeSlaJob: jest.fn(),
}));

jest.mock("../../services/dispute", () => ({
  DisputeService: jest.fn().mockImplementation(() => ({
    getNotesPage: (...args: unknown[]) => mockGetNotesPage(...args),
    addNote: jest.fn(),
  })),
}));

import { disputeRoutes } from "../disputes";

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
  app.use("/api/disputes", disputeRoutes);
  app.use(errorHandler);
  return app;
}

const emptyPage = (overrides: Record<string, unknown> = {}) => ({
  data: [
    {
      id: "note-1",
      author: "agent",
      note: "checked",
      createdAt: new Date().toISOString(),
    },
  ],
  pagination: {
    limit: 50,
    nextCursor: null,
    prevCursor: null,
    hasMore: false,
    sort: "date",
  },
  ...overrides,
});

describe("GET /api/disputes/:disputeId/notes (#622)", () => {
  beforeEach(() => {
    mockGetNotesPage.mockReset();
    mockGetNotesPage.mockResolvedValue(emptyPage());
  });

  it("defaults to a 50 note page sorted by date", async () => {
    const res = await request(createApp()).get("/api/disputes/dispute-1/notes");

    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ limit: 50, sort: "date" });
    expect(mockGetNotesPage).toHaveBeenCalledWith(
      "dispute-1",
      expect.objectContaining({ limit: undefined, sort: "date" }),
    );
  });

  it("forwards limit, cursor and relevance sort", async () => {
    mockGetNotesPage.mockResolvedValue(
      emptyPage({
        pagination: {
          limit: 10,
          nextCursor: "next-cursor",
          prevCursor: null,
          hasMore: true,
          sort: "relevance",
        },
      }),
    );

    const res = await request(createApp()).get(
      "/api/disputes/dispute-1/notes?limit=10&cursor=abc&sort=relevance",
    );

    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({
      limit: 10,
      hasMore: true,
      nextCursor: "next-cursor",
      sort: "relevance",
    });
    expect(mockGetNotesPage).toHaveBeenCalledWith("dispute-1", {
      limit: 10,
      cursor: "abc",
      sort: "relevance",
    });
  });

  it("rejects an unsupported sort value", async () => {
    const res = await request(createApp()).get(
      "/api/disputes/dispute-1/notes?sort=random",
    );

    expect(res.status).toBe(400);
    expect(mockGetNotesPage).not.toHaveBeenCalled();
  });

  it("rejects a non numeric limit", async () => {
    const res = await request(createApp()).get(
      "/api/disputes/dispute-1/notes?limit=abc",
    );

    expect(res.status).toBe(400);
    expect(mockGetNotesPage).not.toHaveBeenCalled();
  });

  it("returns 404 when the dispute does not exist", async () => {
    mockGetNotesPage.mockRejectedValue(new Error("Dispute missing not found"));

    const res = await request(createApp()).get("/api/disputes/missing/notes");

    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed cursor", async () => {
    const { PaginationError } = jest.requireActual("../../utils/pagination");
    mockGetNotesPage.mockRejectedValue(new PaginationError("Invalid cursor"));

    const res = await request(createApp()).get(
      "/api/disputes/dispute-1/notes?cursor=not-a-cursor",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid cursor");
  });
});
