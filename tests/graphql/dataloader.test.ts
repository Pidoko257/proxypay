/**
 * Tests for DataLoader batching and per-request cache isolation.
 *
 * The database is mocked so these tests run without a real DB connection.
 */

jest.mock("../../src/config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

import { queryRead } from "../../src/config/database";
import { createDataLoaders } from "../../src/graphql/dataLoaders";

const mockQueryRead = queryRead as jest.MockedFunction<typeof queryRead>;

describe("createDataLoaders", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── userById ──────────────────────────────────────────────────────────────

  describe("userById", () => {
    it("batches multiple ID lookups into a single query", async () => {
      mockQueryRead.mockResolvedValueOnce({
        rows: [
          { id: "u1", phoneNumber: "+1111", kycLevel: "basic", status: "active", createdAt: new Date() },
          { id: "u2", phoneNumber: "+2222", kycLevel: "full", status: "active", createdAt: new Date() },
        ],
      } as any);

      const loaders = createDataLoaders();
      const [u1, u2] = await Promise.all([
        loaders.userById.load("u1"),
        loaders.userById.load("u2"),
      ]);

      // Only one DB call for both IDs
      expect(mockQueryRead).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQueryRead.mock.calls[0];
      expect(params![0]).toEqual(expect.arrayContaining(["u1", "u2"]));
      expect(sql).toContain("ANY");

      expect(u1?.id).toBe("u1");
      expect(u2?.id).toBe("u2");
    });

    it("returns null for IDs not found in the database", async () => {
      mockQueryRead.mockResolvedValueOnce({ rows: [] } as any);

      const loaders = createDataLoaders();
      const result = await loaders.userById.load("missing-id");

      expect(result).toBeNull();
    });

    it("deduplicates repeated loads of the same ID within one request", async () => {
      mockQueryRead.mockResolvedValueOnce({
        rows: [{ id: "u1", phoneNumber: "+1", kycLevel: "basic", status: "active", createdAt: new Date() }],
      } as any);

      const loaders = createDataLoaders();
      const [a, b] = await Promise.all([
        loaders.userById.load("u1"),
        loaders.userById.load("u1"),
      ]);

      expect(mockQueryRead).toHaveBeenCalledTimes(1);
      expect(a).toBe(b); // same reference from cache
    });
  });

  // ── organizationById ──────────────────────────────────────────────────────

  describe("organizationById", () => {
    it("batches multiple organization ID lookups into a single query", async () => {
      mockQueryRead.mockResolvedValueOnce({
        rows: [
          { id: "org1", name: "Acme Corp" },
          { id: "org2", name: "Globex" },
        ],
      } as any);

      const loaders = createDataLoaders();
      const [o1, o2] = await Promise.all([
        loaders.organizationById.load("org1"),
        loaders.organizationById.load("org2"),
      ]);

      expect(mockQueryRead).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQueryRead.mock.calls[0];
      expect(params![0]).toEqual(expect.arrayContaining(["org1", "org2"]));
      expect(sql).toContain("ANY");

      expect(o1?.name).toBe("Acme Corp");
      expect(o2?.name).toBe("Globex");
    });

    it("returns null for organization IDs not found", async () => {
      mockQueryRead.mockResolvedValueOnce({ rows: [] } as any);

      const loaders = createDataLoaders();
      const result = await loaders.organizationById.load("not-found");

      expect(result).toBeNull();
    });
  });

  // ── per-request isolation ─────────────────────────────────────────────────

  describe("per-request cache isolation", () => {
    it("each call to createDataLoaders returns independent loader instances", async () => {
      // Request 1 — user has status "active"
      mockQueryRead.mockResolvedValueOnce({
        rows: [{ id: "u1", phoneNumber: "+1", kycLevel: "basic", status: "active", createdAt: new Date() }],
      } as any);
      // Request 2 — same user now shows status "frozen"
      mockQueryRead.mockResolvedValueOnce({
        rows: [{ id: "u1", phoneNumber: "+1", kycLevel: "basic", status: "frozen", createdAt: new Date() }],
      } as any);

      const loadersReq1 = createDataLoaders();
      const loadersReq2 = createDataLoaders();

      const [u1Req1, u1Req2] = await Promise.all([
        loadersReq1.userById.load("u1"),
        loadersReq2.userById.load("u1"),
      ]);

      // Two separate DB calls — caches are not shared
      expect(mockQueryRead).toHaveBeenCalledTimes(2);
      expect(u1Req1?.status).toBe("active");
      expect(u1Req2?.status).toBe("frozen");
    });

    it("loader instances from different requests are not the same object", () => {
      const req1 = createDataLoaders();
      const req2 = createDataLoaders();
      expect(req1.userById).not.toBe(req2.userById);
      expect(req1.organizationById).not.toBe(req2.organizationById);
    });
  });

  // ── N+1 verification ─────────────────────────────────────────────────────

  describe("N+1 query prevention", () => {
    it("resolving 10 transactions issues exactly 1 user query and 1 org query", async () => {
      // userById batch
      mockQueryRead.mockResolvedValueOnce({
        rows: Array.from({ length: 5 }, (_, i) => ({
          id: `u${i}`,
          phoneNumber: `+${i}`,
          kycLevel: "basic",
          status: "active",
          createdAt: new Date(),
        })),
      } as any);
      // organizationById batch
      mockQueryRead.mockResolvedValueOnce({
        rows: Array.from({ length: 5 }, (_, i) => ({
          id: `org${i}`,
          name: `Org ${i}`,
        })),
      } as any);

      const loaders = createDataLoaders();

      // Simulate 10 field-resolver calls all dispatched in the same tick
      await Promise.all([
        ...Array.from({ length: 5 }, (_, i) => loaders.userById.load(`u${i}`)),
        ...Array.from({ length: 5 }, (_, i) => loaders.organizationById.load(`org${i}`)),
      ]);

      // 5 user IDs → 1 query; 5 org IDs → 1 query
      expect(mockQueryRead).toHaveBeenCalledTimes(2);
    });
  });
});
