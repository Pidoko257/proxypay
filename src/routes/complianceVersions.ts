/**
 * Compliance Document Version Routes
 *
 * Base path (mounted in index.ts): /api/compliance
 *
 *  GET    /api/compliance/documents/:id/versions
 *  GET    /api/compliance/documents/:id/versions/compare?v1=1&v2=2
 *  GET    /api/compliance/documents/:id/versions/:version
 *  POST   /api/compliance/documents/:id/versions
 *  POST   /api/compliance/documents/:id/versions/:version/restore
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { complianceVersionService } from "../services/complianceVersionService";
import { AuthRequest } from "../middleware/auth";

const router = Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const publishVersionSchema = z.object({
  title: z.string().min(1, "title is required"),
  summary: z.string().nullable().optional(),
  body: z.string().min(1, "body is required"),
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Z]{2}$/, "countryCode must be 2 uppercase letters")
    .nullable()
    .optional(),
  provider: z.string().max(100).nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
  sourceUrl: z.string().url("sourceUrl must be a valid URL").nullable().optional(),
  status: z.enum(["draft", "published", "archived"]).default("published"),
  changeSummary: z.string().min(1, "changeSummary is required"),
});

// ---------------------------------------------------------------------------
// GET /documents/:id/versions
// ---------------------------------------------------------------------------

router.get(
  "/documents/:id/versions",
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<Response> => {
    const { id } = req.params;

    try {
      const history = await complianceVersionService.getVersionHistory(id);
      return res.json({ documentId: id, versions: history, total: history.length });
    } catch (err) {
      console.error("[complianceVersions] listVersions error:", err);
      return res.status(500).json({ error: "Failed to retrieve version history" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /documents/:id/versions/compare?v1=1&v2=2
// NOTE: This route must be declared BEFORE /:version to avoid the literal
//       string "compare" being captured as a version number.
// ---------------------------------------------------------------------------

router.get(
  "/documents/:id/versions/compare",
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<Response> => {
    const { id } = req.params;
    const v1 = parseInt(String(req.query.v1), 10);
    const v2 = parseInt(String(req.query.v2), 10);

    if (isNaN(v1) || isNaN(v2)) {
      return res.status(400).json({ error: "Query params v1 and v2 must be valid integers" });
    }

    if (v1 === v2) {
      return res.status(400).json({ error: "v1 and v2 must be different version numbers" });
    }

    try {
      const comparison = await complianceVersionService.compareVersions(id, v1, v2);
      return res.json(comparison);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        return res.status(404).json({ error: message });
      }
      console.error("[complianceVersions] compareVersions error:", err);
      return res.status(500).json({ error: "Failed to compare versions" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /documents/:id/versions/:version
// ---------------------------------------------------------------------------

router.get(
  "/documents/:id/versions/:version",
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<Response> => {
    const { id } = req.params;
    const versionNumber = parseInt(req.params.version, 10);

    if (isNaN(versionNumber)) {
      return res.status(400).json({ error: "version must be a valid integer" });
    }

    try {
      const { ComplianceDocumentModel } = await import("../models/complianceDocument");
      const model = new ComplianceDocumentModel();
      const version = await model.findVersion(id, versionNumber);

      if (!version) {
        return res.status(404).json({
          error: `Version ${versionNumber} not found for document ${id}`,
        });
      }

      return res.json(version);
    } catch (err) {
      console.error("[complianceVersions] findVersion error:", err);
      return res.status(500).json({ error: "Failed to retrieve version" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /documents/:id/versions   → publish new version
// ---------------------------------------------------------------------------

router.post(
  "/documents/:id/versions",
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<Response> => {
    const { id } = req.params;
    const actorUserId = req.user?.id;

    const parsed = publishVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { changeSummary, ...versionInput } = parsed.data;

    try {
      const result = await complianceVersionService.publishVersion(
        id,
        versionInput,
        changeSummary,
        actorUserId,
      );
      return res.status(201).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        return res.status(404).json({ error: message });
      }
      console.error("[complianceVersions] publishVersion error:", err);
      return res.status(500).json({ error: "Failed to publish version" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /documents/:id/versions/:version/restore
// ---------------------------------------------------------------------------

router.post(
  "/documents/:id/versions/:version/restore",
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<Response> => {
    const { id } = req.params;
    const versionNumber = parseInt(req.params.version, 10);
    const actorUserId = req.user?.id;

    if (isNaN(versionNumber)) {
      return res.status(400).json({ error: "version must be a valid integer" });
    }

    try {
      const restored = await complianceVersionService.restoreVersion(
        id,
        versionNumber,
        actorUserId,
      );
      return res.json({ message: `Restored to version ${versionNumber}`, document: restored });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        return res.status(404).json({ error: message });
      }
      console.error("[complianceVersions] restoreVersion error:", err);
      return res.status(500).json({ error: "Failed to restore version" });
    }
  },
);

export default router;
