/**
 * Tests for Compliance Document Version Control
 *
 * Covers:
 * - ComplianceVersionService.publishVersion()
 * - ComplianceVersionService.getVersionHistory()
 * - ComplianceVersionService.restoreVersion()
 * - ComplianceVersionService.compareVersions()
 */

import { ComplianceVersionService } from "../services/complianceVersionService";
import {
  ComplianceDocumentModel,
  ComplianceDocument,
  ComplianceDocumentVersion,
} from "../models/complianceDocument";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("../models/complianceDocument");

const baseDocument: ComplianceDocument = {
  id: "doc-001",
  title: "AML Policy v1",
  summary: "Anti-Money Laundering policy",
  body: "This policy covers...",
  countryCode: "CM",
  provider: "MTN",
  tags: ["aml", "compliance"],
  sourceUrl: null,
  status: "published",
  createdBy: "user-001",
  updatedBy: "user-001",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const makeVersion = (
  overrides: Partial<ComplianceDocumentVersion> = {},
): ComplianceDocumentVersion => ({
  id: "ver-001",
  documentId: "doc-001",
  versionNumber: 1,
  title: "AML Policy v1",
  summary: "Anti-Money Laundering policy",
  body: "This policy covers...",
  countryCode: "CM",
  provider: "MTN",
  tags: ["aml", "compliance"],
  sourceUrl: null,
  status: "published",
  changeSummary: "Initial version",
  createdBy: "user-001",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

// ---------------------------------------------------------------------------
// ComplianceVersionService unit tests
// ---------------------------------------------------------------------------

describe("ComplianceVersionService", () => {
  let service: ComplianceVersionService;
  let mockModel: jest.Mocked<ComplianceDocumentModel>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Inject mock model via constructor
    mockModel = new ComplianceDocumentModel() as jest.Mocked<ComplianceDocumentModel>;
    service = new ComplianceVersionService(mockModel);
  });

  // ---- publishVersion -------------------------------------------------------

  describe("publishVersion", () => {
    it("updates the document and creates a version snapshot", async () => {
      const updateInput = {
        title: "AML Policy v2",
        body: "Updated policy content...",
      };
      const updatedDoc = { ...baseDocument, ...updateInput, updatedAt: new Date() };
      const newVersion = makeVersion({ versionNumber: 2, title: updateInput.title });

      mockModel.update = jest.fn().mockResolvedValue(updatedDoc);
      mockModel.createVersion = jest.fn().mockResolvedValue(newVersion);

      const result = await service.publishVersion(
        "doc-001",
        updateInput,
        "Added updated policy language",
        "user-001",
      );

      expect(mockModel.update).toHaveBeenCalledWith("doc-001", expect.objectContaining({ title: updateInput.title }), "user-001");
      expect(mockModel.createVersion).toHaveBeenCalledWith(
        "doc-001",
        updateInput,
        "Added updated policy language",
        "user-001",
      );
      expect(result).toHaveProperty("document");
      expect(result).toHaveProperty("version");
      expect(result.document.title).toBe(updateInput.title);
    });

    it("throws when update returns null (document not found)", async () => {
      mockModel.update = jest.fn().mockResolvedValue(null);
      await expect(
        service.publishVersion("nonexistent", { title: "X" }, "change", "user"),
      ).rejects.toThrow("not found");
    });
  });

  // ---- getVersionHistory ----------------------------------------------------

  describe("getVersionHistory", () => {
    it("returns versions with diffBadge enrichment (array)", async () => {
      const versions = [
        makeVersion({ versionNumber: 2, title: "AML Policy v2", changeSummary: "Updated title" }),
        makeVersion({ versionNumber: 1 }),
      ];

      mockModel.listVersions = jest.fn().mockResolvedValue(versions);

      const result = await service.getVersionHistory("doc-001");

      expect(mockModel.listVersions).toHaveBeenCalledWith("doc-001");
      // Returns a VersionHistoryEntry[] (array, not object)
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      // Each entry should have a diffBadge
      result.forEach((v) => {
        expect(v).toHaveProperty("versionNumber");
        expect(v).toHaveProperty("diffBadge");
      });
    });

    it("uses changeSummary as diffBadge for the oldest version (no predecessor)", async () => {
      // listVersions returns DESC: v2 at [0], v1 at [1]
      // v1 has no previous → diffBadge falls back to its own changeSummary
      // v2 has v1 as previous and its own changeSummary → used as badge
      const v2 = makeVersion({ versionNumber: 2, changeSummary: "Fixed typos" });
      const v1 = makeVersion({ versionNumber: 1, changeSummary: "Initial version" });
      mockModel.listVersions = jest.fn().mockResolvedValue([v2, v1]);

      const result = await service.getVersionHistory("doc-001");
      // v2 (index 0): has a previous version and own changeSummary → "Fixed typos"
      expect(result[0].diffBadge).toBe("Fixed typos");
      // v1 (index 1): no previous → falls back to its own changeSummary
      expect(result[1].diffBadge).toBe("Initial version");
    });

    it("generates diffBadge from changed fields when changeSummary is empty", async () => {
      const v2 = makeVersion({ versionNumber: 2, title: "Changed Title", changeSummary: undefined as any });
      const v1 = makeVersion({ versionNumber: 1, changeSummary: undefined as any });
      mockModel.listVersions = jest.fn().mockResolvedValue([v2, v1]);

      const result = await service.getVersionHistory("doc-001");
      // v2 compared to v1: title changed
      expect(result[0].diffBadge).toContain("title");
    });

    it("returns empty array when no versions exist", async () => {
      mockModel.listVersions = jest.fn().mockResolvedValue([]);
      const result = await service.getVersionHistory("doc-001");
      expect(result).toHaveLength(0);
    });
  });

  // ---- restoreVersion -------------------------------------------------------

  describe("restoreVersion", () => {
    it("restores document to a prior version state", async () => {
      const restoredDoc = { ...baseDocument, updatedAt: new Date() };
      mockModel.restoreVersion = jest.fn().mockResolvedValue(restoredDoc);

      const result = await service.restoreVersion("doc-001", 1, "admin");

      expect(mockModel.restoreVersion).toHaveBeenCalledWith("doc-001", 1, "admin");
      expect(result).toEqual(restoredDoc);
    });

    it("throws when restoreVersion returns null (version not found)", async () => {
      mockModel.restoreVersion = jest.fn().mockResolvedValue(null);
      await expect(service.restoreVersion("doc-001", 99, "admin")).rejects.toThrow(
        "not found",
      );
    });
  });

  // ---- compareVersions ------------------------------------------------------

  describe("compareVersions", () => {
    it("returns field-by-field diff between two versions", async () => {
      const v1 = makeVersion({ versionNumber: 1 });
      const v2 = makeVersion({
        versionNumber: 2,
        title: "AML Policy v2 - Updated",
        body: "Completely new body content.",
        tags: ["aml", "compliance", "new-tag"],
      });

      mockModel.findVersion = jest.fn()
        .mockResolvedValueOnce(v1)
        .mockResolvedValueOnce(v2);

      const result = await service.compareVersions("doc-001", 1, 2);

      // Actual shape: { documentId, v1, v2, diffs, hasChanges }
      expect(result).toHaveProperty("documentId", "doc-001");
      expect(result).toHaveProperty("v1", 1);
      expect(result).toHaveProperty("v2", 2);
      expect(result).toHaveProperty("diffs");
      expect(result).toHaveProperty("hasChanges", true);

      // diffs is an array of { field, from, to, changed }
      const titleDiff = result.diffs.find((d: any) => d.field === "title");
      expect(titleDiff).toBeDefined();
      expect(titleDiff!.changed).toBe(true);
      expect(titleDiff!.from).toBe(v1.title);
      expect(titleDiff!.to).toBe(v2.title);

      const bodyDiff = result.diffs.find((d: any) => d.field === "body");
      expect(bodyDiff!.changed).toBe(true);

      const tagsDiff = result.diffs.find((d: any) => d.field === "tags");
      expect(tagsDiff!.changed).toBe(true);
    });

    it("marks unchanged fields with changed: false", async () => {
      const v1 = makeVersion({ versionNumber: 1 });
      const v2 = makeVersion({ versionNumber: 2, body: "Updated body only." });

      mockModel.findVersion = jest.fn()
        .mockResolvedValueOnce(v1)
        .mockResolvedValueOnce(v2);

      const result = await service.compareVersions("doc-001", 1, 2);
      const titleDiff = result.diffs.find((d: any) => d.field === "title");
      expect(titleDiff!.changed).toBe(false);
    });

    it("returns hasChanges: false when versions are identical", async () => {
      const v1 = makeVersion({ versionNumber: 1 });
      const v2 = makeVersion({ versionNumber: 2 }); // same content

      mockModel.findVersion = jest.fn()
        .mockResolvedValueOnce(v1)
        .mockResolvedValueOnce(v2);

      const result = await service.compareVersions("doc-001", 1, 2);
      expect(result.hasChanges).toBe(false);
    });

    it("throws when either version is not found", async () => {
      mockModel.findVersion = jest.fn().mockResolvedValue(null);
      await expect(service.compareVersions("doc-001", 1, 99)).rejects.toThrow(
        "not found",
      );
    });
  });
});
