/**
 * Enhanced Data Export Routes — Issue #202
 *
 * Extends the base export (CSV/JSON streaming) with:
 *   - PDF export
 *   - Scheduled exports (create, list, delete)
 *   - GDPR-compliant full data export
 *   - Export access logging
 *   - Export templates
 *
 * Base CSV/JSON streaming remains unchanged in the original export.ts.
 * This router adds the new endpoints under /api/exports/...
 */

import { Router, Request, Response } from "express";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { z } from "zod";
import {
  dataExportService,
  ExportFormat,
  ExportSchedule,
  GdprCategory,
  rowToCsv,
  buildPdfBuffer,
} from "../services/dataExportService";
import { authenticateToken, AuthRequest } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const exportQuerySchema = z.object({
  format: z.enum(["csv", "json", "pdf"] as const).default("csv"),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  provider: z.string().optional(),
  userId: z.string().optional(),  // admin-only override
});

const scheduleExportSchema = z.object({
  format: z.enum(["csv", "json", "pdf"] as const),
  schedule: z.enum(["daily", "weekly", "monthly"] as const),
  filters: z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    status: z.string().optional(),
    type: z.string().optional(),
    provider: z.string().optional(),
  }).optional(),
  deliverToEmail: z.boolean().default(false),
  templateId: z.string().optional(),
});

const gdprExportSchema = z.object({
  categories: z
    .array(z.enum(["transactions", "profile", "kyc", "audit_logs", "all"] as const))
    .min(1)
    .default(["all"]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getScopedUserId(req: Request): string | null {
  return (req as any).user?.id || (req as any).jwtUser?.userId || null;
}

function setDownloadHeaders(res: Response, format: ExportFormat, baseName: string): void {
  const date = new Date().toISOString().slice(0, 10);
  const extMap: Record<ExportFormat, string> = { csv: "csv", json: "json", pdf: "html" };
  const ctMap: Record<ExportFormat, string> = {
    csv: "text/csv; charset=utf-8",
    json: "application/json",
    pdf: "text/html; charset=utf-8",
  };
  const ext = extMap[format];
  const ct = ctMap[format];
  res.setHeader("Content-Type", ct);
  res.setHeader("Content-Disposition", `attachment; filename="${baseName}-${date}.${ext}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/exports/transactions
 * Export transaction history in CSV, JSON, or PDF format.
 *
 * Query params: format, startDate, endDate, status, type, provider
 *
 * Streaming for CSV/JSON; in-memory for PDF (capped at 500 rows).
 */
router.get(
  "/transactions",
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
    let client: any;
    let clientReleased = false;
    const releaseClient = () => {
      if (!clientReleased && client) {
        client.release();
        clientReleased = true;
      }
    };

    try {
      const params = exportQuerySchema.parse(req.query);
      const { format, ...filterRaw } = params;
      const isAdmin = (req as any).jwtUser?.roles?.includes("admin");

      const filters = {
        ...filterRaw,
        userId: isAdmin && filterRaw.userId ? filterRaw.userId : getScopedUserId(req) ?? undefined,
      };

      const { db, createQueryStream } = (() => {
        const dbModule = require("../config/database");
        const qsModule = require("pg-query-stream");
        return { db: dbModule.pool, createQueryStream: qsModule };
      })();

      // PDF: fetch all rows in-memory (capped), build HTML-based PDF buffer
      if (format === "pdf") {
        const { text, values } = dataExportService.buildTransactionQuery(filters);
        const result = await db.query(text + " LIMIT 500", values);
        const headers = dataExportService.getCsvHeaders();
        const pdfBuffer = buildPdfBuffer("Transaction Export", result.rows, headers);

        await dataExportService.logExportAccess(
          filters.userId ?? "anonymous",
          "pdf",
          filters,
          result.rows.length,
          req.ip,
        );

        setDownloadHeaders(res, "pdf", "transactions");
        return res.send(pdfBuffer);
      }

      // CSV / JSON: stream
      const { text, values } = dataExportService.buildTransactionQuery(filters);
      client = await db.connect();
      const qs = createQueryStream(text, values);
      const rowStream = client.query(qs);

      const csvHeaders = dataExportService.getCsvHeaders();
      setDownloadHeaders(res, format, "transactions");
      res.status(200);

      let transform: Transform;
      let rowCount = 0;

      if (format === "csv") {
        res.write(csvHeaders.join(",") + "\n");
        transform = new Transform({
          objectMode: true,
          transform(chunk: Record<string, unknown>, _enc, cb) {
            rowCount++;
            cb(null, rowToCsv(chunk, csvHeaders));
          },
        });
      } else {
        let first = true;
        res.write("[\n");
        transform = new Transform({
          objectMode: true,
          transform(chunk: Record<string, unknown>, _enc, cb) {
            rowCount++;
            cb(null, (first ? "" : ",\n") + JSON.stringify(chunk, null, 2));
            first = false;
          },
          flush(cb) {
            res.write("\n]");
            cb();
          },
        });
      }

      res.on("close", () => {
        if ("destroy" in rowStream && typeof rowStream.destroy === "function") {
          rowStream.destroy();
        }
        releaseClient();
      });

      await pipeline(rowStream, transform, res);

      await dataExportService.logExportAccess(
        filters.userId ?? "anonymous",
        format,
        filters,
        rowCount,
        req.ip,
      );
    } catch (error: any) {
      releaseClient();
      if (error.name === "ZodError") {
        if (!res.headersSent) {
          return res.status(400).json({ success: false, error: "Invalid query parameters", details: error.errors });
        }
        return;
      }
      console.error("[DataExport] transaction export error:", error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: "Export failed" });
      }
    }
  },
);

/**
 * GET /api/exports/scheduled
 * List all scheduled exports for the authenticated user.
 */
router.get(
  "/scheduled",
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getScopedUserId(req);
      if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required");

      const exports = await dataExportService.getScheduledExports(userId);
      res.json({ success: true, data: exports });
    } catch (error) {
      console.error("[DataExport] list scheduled error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to list scheduled exports");
    }
  },
);

/**
 * POST /api/exports/scheduled
 * Create a scheduled export job.
 *
 * Body:
 * {
 *   "format": "csv",
 *   "schedule": "weekly",
 *   "filters": { "provider": "mtn" },
 *   "deliverToEmail": true
 * }
 */
router.post(
  "/scheduled",
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getScopedUserId(req);
      if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required");

      const data = scheduleExportSchema.parse(req.body);

      const scheduledExport = await dataExportService.createScheduledExport({
        userId,
        format: data.format,
        schedule: data.schedule,
        filters: data.filters ?? {},
        deliverToEmail: data.deliverToEmail,
        templateId: data.templateId,
      });

      res.status(201).json({
        success: true,
        data: scheduledExport,
        message: `${data.schedule} export scheduled in ${data.format} format`,
      });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[DataExport] create scheduled error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to create scheduled export");
    }
  },
);

/**
 * DELETE /api/exports/scheduled/:id
 * Delete a scheduled export.
 */
router.delete(
  "/scheduled/:id",
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getScopedUserId(req);
      if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required");

      const deleted = await dataExportService.deleteScheduledExport(req.params.id, userId);
      if (!deleted) {
        throw createError(ERROR_CODES.NOT_FOUND, "Scheduled export not found");
      }

      res.json({ success: true, message: "Scheduled export deleted" });
    } catch (error) {
      console.error("[DataExport] delete scheduled error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to delete scheduled export");
    }
  },
);

/**
 * GET /api/exports/gdpr
 * GDPR-compliant full data export for the authenticated user.
 *
 * Query params: categories (comma-separated: transactions,profile,kyc,audit_logs,all)
 * Returns a JSON file containing all personal data.
 *
 * This supplements the existing /api/gdpr/export endpoint (which handles deletion too).
 */
router.get(
  "/gdpr",
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getScopedUserId(req);
      if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required");

      const rawCategories = req.query.categories
        ? String(req.query.categories).split(",").map((c) => c.trim())
        : ["all"];

      const parsed = gdprExportSchema.parse({ categories: rawCategories });

      const exportPackage = await dataExportService.buildGdprExportPackage(
        userId,
        parsed.categories,
      );

      await dataExportService.logExportAccess(userId, "json", { userId }, 1, req.ip);

      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="gdpr-export-${userId.slice(0, 8)}-${date}.json"`,
      );
      res.json(exportPackage);
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[DataExport] GDPR export error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to generate GDPR export");
    }
  },
);

/**
 * GET /api/exports/templates
 * List available export templates.
 */
router.get(
  "/templates",
  authenticateToken,
  async (_req: Request, res: Response) => {
    // Built-in templates — extensible via DB in the future
    const templates = [
      {
        id: "monthly_summary",
        name: "Monthly Summary",
        description: "Monthly transaction summary with totals by provider",
        format: "csv",
        filters: { status: "completed" },
      },
      {
        id: "failed_transactions",
        name: "Failed Transactions",
        description: "All failed transactions for troubleshooting",
        format: "csv",
        filters: { status: "failed" },
      },
      {
        id: "full_history_pdf",
        name: "Full Transaction History (PDF)",
        description: "Complete transaction history as a printable PDF",
        format: "pdf",
        filters: {},
      },
      {
        id: "gdpr_data_package",
        name: "GDPR Data Package",
        description: "Complete user data package for GDPR compliance",
        format: "json",
        filters: {},
      },
    ];

    res.json({ success: true, data: templates });
  },
);

export default router;
