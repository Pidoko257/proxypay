import { Router, Request, Response } from "express";
import { authenticateToken } from "../middleware/auth";
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import { authorizeObj } from "../middleware/rbac";
import {
  listAmlAlertsForAudit,
  getAmlAlertDetails,
  reviewAmlAlert,
  searchAmlAlertsByUser,
  getAmlDashboardStats,
  markAlertForSAR,
} from "../controllers/amlAuditController";
import {
  queryAuditEvents,
  exportAuditEventsAsCsv,
  exportAuditEventsAsJson,
  AuditCategory,
} from "../services/comprehensiveAuditService";

export const auditRoutes = Router();

// All audit routes require authentication
auditRoutes.use(authenticateToken);

/**
 * AML Audit Dashboard Routes
 * Read-only view for compliance officers to review flagged transactions
 */

// List all AML alerts with filtering and pagination
auditRoutes.get(
  "/aml/alerts",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("aml_alerts", "read"),
  listAmlAlertsForAudit,
);

// Search AML alerts by userId and intensity (severity)
auditRoutes.get(
  "/aml/alerts/search",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("aml_alerts", "read"),
  searchAmlAlertsByUser,
);

// Get AML dashboard statistics
auditRoutes.get(
  "/aml/stats",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("aml_alerts", "read"),
  getAmlDashboardStats,
);

// Get detailed AML alert with transaction context
auditRoutes.get(
  "/aml/alerts/:alertId",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("aml_alerts", "read"),
  getAmlAlertDetails,
);

// Review an AML alert (update status to reviewed/dismissed)
auditRoutes.patch(
  "/aml/alerts/:alertId/review",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("aml_alerts", "write"),
  reviewAmlAlert,
);

// Manually trigger SAR generation for an alert
auditRoutes.post(
  "/aml/alerts/:alertId/sar",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("aml_alerts", "write"),
  markAlertForSAR,
);

// ─── Comprehensive Audit Events — Issue #167 ──────────────────────────────────

/**
 * GET /api/audit/events
 *
 * Query audit events with flexible filtering.
 * Query params: actorId, resourceType, resourceId, category, eventType,
 *               from, to, success, limit, offset
 */
auditRoutes.get(
  "/events",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("audit_events", "read"),
  async (req: Request, res: Response) => {
    try {
      const {
        actorId,
        resourceType,
        resourceId,
        category,
        eventType,
        from,
        to,
        success,
        limit,
        offset,
      } = req.query as Record<string, string | undefined>;

      const result = await queryAuditEvents({
        actorId,
        resourceType,
        resourceId,
        category,
        eventType,
        from,
        to,
        success: success !== undefined ? success === "true" : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: "Failed to query audit events",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/**
 * GET /api/audit/events/export
 *
 * Export audit events as CSV (default) or JSON.
 * Query param: format=csv|json
 */
auditRoutes.get(
  "/events/export",
  TimeoutPresets.standard,
  haltOnTimedout,
  authorizeObj("audit_events", "read"),
  async (req: Request, res: Response) => {
    const {
      format = "csv",
      actorId,
      resourceType,
      resourceId,
      category,
      eventType,
      from,
      to,
      limit,
    } = req.query as Record<string, string | undefined>;

    const filter = {
      actorId,
      resourceType,
      resourceId,
      category,
      eventType,
      from,
      to,
      limit: limit ? parseInt(limit, 10) : 10_000,
    };

    try {
      if (format === "json") {
        const json = await exportAuditEventsAsJson(filter);
        res
          .header("Content-Type", "application/json")
          .header(
            "Content-Disposition",
            `attachment; filename="audit_events_${Date.now()}.json"`,
          )
          .send(json);
      } else {
        const csv = await exportAuditEventsAsCsv(filter);
        res
          .header("Content-Type", "text/csv")
          .header(
            "Content-Disposition",
            `attachment; filename="audit_events_${Date.now()}.csv"`,
          )
          .send(csv);
      }
    } catch (err) {
      res.status(500).json({
        error: "Failed to export audit events",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/**
 * GET /api/audit/events/user/:userId
 *
 * Fetch all audit events for a specific user (actor or target resource).
 */
auditRoutes.get(
  "/events/user/:userId",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("audit_events", "read"),
  async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { limit, offset, from, to } = req.query as Record<string, string | undefined>;

    try {
      const result = await queryAuditEvents({
        actorId: userId,
        from,
        to,
        limit: limit ? parseInt(limit, 10) : 100,
        offset: offset ? parseInt(offset, 10) : 0,
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: "Failed to fetch user audit events",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/**
 * GET /api/audit/events/transaction/:transactionId
 *
 * Fetch all audit events for a specific transaction.
 */
auditRoutes.get(
  "/events/transaction/:transactionId",
  TimeoutPresets.quick,
  haltOnTimedout,
  authorizeObj("audit_events", "read"),
  async (req: Request, res: Response) => {
    const { transactionId } = req.params;
    const { limit, offset } = req.query as Record<string, string | undefined>;

    try {
      const result = await queryAuditEvents({
        resourceType: "transaction",
        resourceId: transactionId,
        category: AuditCategory.FINANCIAL,
        limit: limit ? parseInt(limit, 10) : 100,
        offset: offset ? parseInt(offset, 10) : 0,
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: "Failed to fetch transaction audit events",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);
