import express, { Request, Response } from "express";
import { authenticate, authorize } from "../middleware/auth";
import { analyticsService } from "../services/analyticsService";
import logger from "../utils/logger";

const router = express.Router();

/**
 * POST /analytics/event
 * Log a single event
 */
router.post("/event", authenticate, async (req: Request, res: Response) => {
  try {
    const { eventType, eventName, properties, platform } = req.body;

    await analyticsService.logEvent({
      eventType,
      eventCategory: "user_action",
      eventName,
      userId: req.user?.id,
      properties,
      platform,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to log event:", error);
    res.status(500).json({ success: false, error: "Failed to log event" });
  }
});

/**
 * GET /analytics/dashboard
 * Get dashboard summary metrics
 */
router.get("/dashboard", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const { period = "today" } = req.query;

    const metrics = await analyticsService.getDashboardMetrics(
      (period as "today" | "week" | "month") || "today",
    );

    res.json({
      success: true,
      data: metrics,
    });
  } catch (error) {
    logger.error("Failed to get dashboard metrics:", error);
    res.status(500).json({ success: false, error: "Failed to get dashboard metrics" });
  }
});

/**
 * GET /analytics/transactions/trends
 * Get transaction trends
 */
router.get("/transactions/trends", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: "startDate and endDate required" });
    }

    const trends = await analyticsService.getTransactionTrends(
      new Date(String(startDate)),
      new Date(String(endDate)),
    );

    res.json({
      success: true,
      data: trends,
    });
  } catch (error) {
    logger.error("Failed to get transaction trends:", error);
    res.status(500).json({ success: false, error: "Failed to get trends" });
  }
});

/**
 * GET /analytics/cohorts
 * Get cohort analysis
 */
router.get("/cohorts", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const { cohortId } = req.query;

    const cohorts = await analyticsService.getCohortAnalysis(String(cohortId || ""));

    res.json({
      success: true,
      data: cohorts,
    });
  } catch (error) {
    logger.error("Failed to get cohort analysis:", error);
    res.status(500).json({ success: false, error: "Failed to get cohorts" });
  }
});

/**
 * POST /analytics/cohorts
 * Create new cohort
 */
router.post("/cohorts", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const { name, type, definition } = req.body;

    const cohortId = await analyticsService.createCohort({ name, type, definition });

    res.json({
      success: true,
      cohortId,
    });
  } catch (error) {
    logger.error("Failed to create cohort:", error);
    res.status(500).json({ success: false, error: "Failed to create cohort" });
  }
});

/**
 * GET /analytics/funnels
 * Get funnel analysis
 */
router.get("/funnels", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const { funnelId } = req.query;

    const funnels = await analyticsService.getFunnelAnalysis(String(funnelId || ""));

    res.json({
      success: true,
      data: funnels,
    });
  } catch (error) {
    logger.error("Failed to get funnel analysis:", error);
    res.status(500).json({ success: false, error: "Failed to get funnels" });
  }
});

/**
 * POST /analytics/funnels/track
 * Track funnel event
 */
router.post("/funnels/track", authenticate, async (req: Request, res: Response) => {
  try {
    const { funnelId, stepIndex, stepName, status, reason } = req.body;

    await analyticsService.trackFunnelEvent({
      funnelId,
      userId: req.user?.id || "",
      stepIndex,
      stepName,
      status,
      reason,
    });

    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to track funnel event:", error);
    res.status(500).json({ success: false, error: "Failed to track funnel" });
  }
});

/**
 * GET /analytics/retention
 * Get user retention curves
 */
router.get("/retention", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: "startDate and endDate required" });
    }

    const retention = await analyticsService.getUserRetention(
      new Date(String(startDate)),
      new Date(String(endDate)),
    );

    res.json({
      success: true,
      data: retention,
    });
  } catch (error) {
    logger.error("Failed to get retention data:", error);
    res.status(500).json({ success: false, error: "Failed to get retention" });
  }
});

/**
 * GET /analytics/export
 * Export analytics data
 */
router.get("/export", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const { format = "csv", startDate, endDate, eventType } = req.query;

    const data = await analyticsService.exportData(format as "csv" | "json" | "parquet", {
      startDate: startDate ? new Date(String(startDate)) : undefined,
      endDate: endDate ? new Date(String(endDate)) : undefined,
      eventType: String(eventType || ""),
    });

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="analytics-export.csv"');
    } else {
      res.setHeader("Content-Type", "application/json");
    }

    res.send(data);
  } catch (error) {
    logger.error("Failed to export data:", error);
    res.status(500).json({ success: false, error: "Failed to export data" });
  }
});

export default router;
