/**
 * Advanced Reporting API — Issue #205
 *
 * Endpoints:
 *   GET    /api/reports/pnl                           — P&L report
 *   GET    /api/reports/settlement                    — Settlement report
 *   GET    /api/reports/kyc-compliance                — KYC compliance report
 *   POST   /api/reports/custom                        — Custom report builder
 *   GET    /api/reports/scheduled                     — List scheduled reports
 *   POST   /api/reports/scheduled                     — Create scheduled report
 *   DELETE /api/reports/scheduled/:id                 — Delete scheduled report
 *   GET    /api/reports/archive                       — Report archive
 *   POST   /api/reports/archive                       — Archive a report
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  advancedReportingService,
  ReportType,
  CustomReportDefinition,
} from "../services/advancedReportingService";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { haltOnTimedout } from "../middleware/timeout";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const periodSchema = z
  .object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format"),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format"),
  })
  .refine((d) => d.startDate <= d.endDate, {
    message: "startDate must be before or equal to endDate",
    path: ["endDate"],
  });

const customReportSchema = z.object({
  metrics: z
    .array(z.enum(["count", "sum_amount", "sum_fees", "avg_amount"] as const))
    .min(1),
  groupBy: z
    .array(z.enum(["date", "provider", "status", "type", "currency"] as const))
    .min(0),
  filters: z
    .object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      provider: z.string().optional(),
      status: z.string().optional(),
      type: z.string().optional(),
    })
    .optional()
    .default({}),
});

const scheduleReportSchema = z.object({
  reportType: z.enum(["pnl", "settlement", "aml", "kyc_compliance", "custom"] as const),
  schedule: z.enum(["daily", "weekly", "monthly"] as const),
  format: z.enum(["json", "csv"] as const).default("json"),
  parameters: z.record(z.unknown()).default({}),
  deliverToEmail: z.boolean().default(false),
  recipients: z.array(z.string().email()).default([]),
});

const archiveReportSchema = z.object({
  reportType: z.enum(["pnl", "settlement", "aml", "kyc_compliance", "custom"] as const),
  format: z.enum(["json", "csv"] as const).default("json"),
  parameters: z.record(z.unknown()).default({}),
  payload: z.record(z.unknown()),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatCsvFromReport(report: Record<string, unknown>): string {
  // Flatten daily breakdown / settlements arrays to CSV
  const findRows = (obj: Record<string, unknown>): Record<string, unknown>[] | null => {
    for (const val of Object.values(obj)) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
        return val as Record<string, unknown>[];
      }
    }
    return null;
  };

  const rows = findRows(report);
  if (!rows || rows.length === 0) {
    return JSON.stringify(report);
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => {
          const val = row[h] ?? "";
          const s = String(val);
          return s.includes(",") ? `"${s}"` : s;
        })
        .join(","),
    );
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/reports/pnl
 * Profit & Loss report for a date range.
 *
 * Query params: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), format (json|csv)
 */
router.get(
  "/pnl",
  haltOnTimedout,
  requireAuth,
  requirePermission("admin:system"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { startDate, endDate } = periodSchema.parse({
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      });
      const format = req.query.format === "csv" ? "csv" : "json";

      const report = await advancedReportingService.generatePnLReport({
        start: startDate,
        end: endDate,
      });

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="pnl-report-${startDate}-${endDate}.csv"`,
        );
        return res.send(formatCsvFromReport(report as unknown as Record<string, unknown>));
      }

      res.json({ success: true, data: report });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[AdvancedReports] P&L error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to generate P&L report");
    }
  },
);

/**
 * GET /api/reports/settlement
 * Settlement report broken down by provider.
 *
 * Query params: startDate, endDate, format (json|csv)
 */
router.get(
  "/settlement",
  haltOnTimedout,
  requireAuth,
  requirePermission("admin:system"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { startDate, endDate } = periodSchema.parse({
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      });
      const format = req.query.format === "csv" ? "csv" : "json";

      const report = await advancedReportingService.generateSettlementReport({
        start: startDate,
        end: endDate,
      });

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="settlement-report-${startDate}-${endDate}.csv"`,
        );
        return res.send(formatCsvFromReport(report as unknown as Record<string, unknown>));
      }

      res.json({ success: true, data: report });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[AdvancedReports] settlement error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to generate settlement report");
    }
  },
);

/**
 * GET /api/reports/kyc-compliance
 * KYC compliance report.
 *
 * Query params: startDate, endDate
 */
router.get(
  "/kyc-compliance",
  haltOnTimedout,
  requireAuth,
  requirePermission("admin:system"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { startDate, endDate } = periodSchema.parse({
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      });

      const report = await advancedReportingService.generateKycComplianceReport({
        start: startDate,
        end: endDate,
      });

      res.json({ success: true, data: report });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[AdvancedReports] KYC compliance error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to generate KYC compliance report",
      );
    }
  },
);

/**
 * POST /api/reports/custom
 * Custom report builder — specify metrics, groupBy, and filters.
 *
 * Body:
 * {
 *   "metrics": ["count", "sum_amount", "sum_fees"],
 *   "groupBy": ["date", "provider"],
 *   "filters": { "startDate": "2026-01-01", "endDate": "2026-07-30" }
 * }
 */
router.post(
  "/custom",
  haltOnTimedout,
  requireAuth,
  requirePermission("admin:system"),
  async (req: AuthRequest, res: Response) => {
    try {
      const definition = customReportSchema.parse(req.body) as CustomReportDefinition;
      const result = await advancedReportingService.generateCustomReport(definition);

      const format = req.query.format === "csv" ? "csv" : "json";
      if (format === "csv") {
        const rows = result.rows;
        if (rows.length === 0) return res.send("");
        const headers = Object.keys(rows[0]);
        const lines = [
          headers.join(","),
          ...rows.map((r) =>
            headers
              .map((h) => {
                const v = r[h] ?? "";
                const s = String(v);
                return s.includes(",") ? `"${s}"` : s;
              })
              .join(","),
          ),
        ];
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", 'attachment; filename="custom-report.csv"');
        return res.send(lines.join("\n"));
      }

      res.json({ success: true, data: result });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[AdvancedReports] custom report error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to generate custom report");
    }
  },
);

/**
 * GET /api/reports/scheduled
 * List all scheduled reports.
 */
router.get(
  "/scheduled",
  requireAuth,
  requirePermission("admin:system"),
  async (_req: AuthRequest, res: Response) => {
    try {
      const reports = await advancedReportingService.getScheduledReports();
      res.json({ success: true, data: reports });
    } catch (error) {
      console.error("[AdvancedReports] list scheduled error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to list scheduled reports");
    }
  },
);

/**
 * POST /api/reports/scheduled
 * Create a scheduled report.
 *
 * Body:
 * {
 *   "reportType": "pnl",
 *   "schedule": "monthly",
 *   "format": "csv",
 *   "deliverToEmail": true,
 *   "recipients": ["cfo@example.com"]
 * }
 */
router.post(
  "/scheduled",
  requireAuth,
  requirePermission("admin:system"),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = scheduleReportSchema.parse(req.body);
      const report = await advancedReportingService.createScheduledReport(
        data,
        req.jwtUser!.userId,
      );
      res.status(201).json({ success: true, data: report });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[AdvancedReports] create scheduled error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to create scheduled report");
    }
  },
);

/**
 * DELETE /api/reports/scheduled/:id
 * Delete a scheduled report.
 */
router.delete(
  "/scheduled/:id",
  requireAuth,
  requirePermission("admin:system"),
  async (req: AuthRequest, res: Response) => {
    try {
      const deleted = await advancedReportingService.deleteScheduledReport(req.params.id);
      if (!deleted) {
        throw createError(ERROR_CODES.NOT_FOUND, "Scheduled report not found");
      }
      res.json({ success: true, message: "Scheduled report deleted" });
    } catch (error) {
      console.error("[AdvancedReports] delete scheduled error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to delete scheduled report");
    }
  },
);

/**
 * GET /api/reports/archive
 * Retrieve archived reports. Filter by ?reportType=pnl
 */
router.get(
  "/archive",
  requireAuth,
  requirePermission("admin:system"),
  async (req: AuthRequest, res: Response) => {
    try {
      const validTypes: ReportType[] = ["pnl", "settlement", "aml", "kyc_compliance", "custom"];
      const rtParam = req.query.reportType as string | undefined;
      const reportType =
        rtParam && validTypes.includes(rtParam as ReportType)
          ? (rtParam as ReportType)
          : undefined;

      const archives = await advancedReportingService.getReportArchives(reportType);
      res.json({ success: true, data: archives });
    } catch (error) {
      console.error("[AdvancedReports] get archive error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch report archive");
    }
  },
);

/**
 * POST /api/reports/archive
 * Archive a generated report for future retrieval.
 *
 * Body: { reportType, format, parameters, payload, retentionDays? }
 */
router.post(
  "/archive",
  requireAuth,
  requirePermission("admin:system"),
  async (req: AuthRequest, res: Response) => {
    try {
      const data = archiveReportSchema.parse(req.body);
      const archive = await advancedReportingService.archiveReport(
        data,
        req.jwtUser!.userId,
      );
      res.status(201).json({ success: true, data: archive });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[AdvancedReports] archive error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to archive report");
    }
  },
);

export { router as advancedReportsRouter };
