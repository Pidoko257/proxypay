import express, { Request, Response } from "express";
import { authenticate, authorize } from "../middleware/auth";
import { walletReconciliationService } from "../services/walletReconciliationService";
import { reconciliationReportService } from "../services/reconciliationReportService";
import { adminReconciliationService } from "../services/adminReconciliationService";
import { discrepancyAlertService } from "../services/discrepancyAlertService";
import { addReconciliationJob, getReconciliationQueueStats } from "../queue/reconciliationQueue";
import { walletDiscrepancyModel } from "../models/reconciliation";
import logger from "../utils/logger";

const router = express.Router();

/**
 * POST /reconciliation/trigger
 * Manually trigger a reconciliation job
 */
router.post("/trigger", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const { jobType = "stellar_ledger", userId } = req.body;

    const job = await addReconciliationJob({
      jobType,
      userId,
      priority: "high",
    });

    res.json({
      success: true,
      jobId: job.id,
      status: "queued",
    });
  } catch (error) {
    logger.error("Failed to trigger reconciliation:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /reconciliation/dashboard
 * Get reconciliation dashboard metrics
 */
router.get("/dashboard", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const metrics = await reconciliationReportService.getDashboardMetrics();

    res.json({
      success: true,
      data: metrics,
    });
  } catch (error) {
    logger.error("Failed to get dashboard metrics:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /reconciliation/report
 * Generate reconciliation report for period
 */
router.get("/report", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: "startDate and endDate are required",
      });
    }

    const start = new Date(String(startDate));
    const end = new Date(String(endDate));

    const report = await reconciliationReportService.generateReport(start, end);

    res.json({
      success: true,
      data: report,
    });
  } catch (error) {
    logger.error("Failed to generate report:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /reconciliation/report/csv
 * Export report as CSV
 */
router.get("/report/csv", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: "startDate and endDate are required",
      });
    }

    const start = new Date(String(startDate));
    const end = new Date(String(endDate));

    const csv = await reconciliationReportService.exportReportToCsv(start, end);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="reconciliation-report.csv"');
    res.send(csv);
  } catch (error) {
    logger.error("Failed to export CSV:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /reconciliation/discrepancies
 * Get pending discrepancies
 */
router.get("/discrepancies", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const { limit = "100", status } = req.query;

    const result = await walletDiscrepancyModel.getPendingDiscrepancies(parseInt(String(limit), 10));

    res.json({
      success: true,
      data: result,
      count: result.length,
    });
  } catch (error) {
    logger.error("Failed to get discrepancies:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * PUT /reconciliation/discrepancies/:id/approve
 * Approve a discrepancy correction
 */
router.put(
  "/discrepancies/:id/approve",
  authenticate,
  authorize("admin", "super-admin"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const updated = await adminReconciliationService.approveDiscrepancyCorrection(id, adminId, notes);

      res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      logger.error("Failed to approve discrepancy:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * PUT /reconciliation/discrepancies/:id/reject
 * Reject a discrepancy correction
 */
router.put(
  "/discrepancies/:id/reject",
  authenticate,
  authorize("admin", "super-admin"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const updated = await adminReconciliationService.rejectDiscrepancyCorrection(id, adminId, reason);

      res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      logger.error("Failed to reject discrepancy:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * POST /reconciliation/bulk-approve
 * Bulk approve pending discrepancies
 */
router.post(
  "/bulk-approve",
  authenticate,
  authorize("admin", "super-admin"),
  async (req: Request, res: Response) => {
    try {
      const { limit = 50 } = req.body;
      const adminId = req.user?.id;

      if (!adminId) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const result = await adminReconciliationService.bulkApprovePending(limit, adminId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error("Failed to bulk approve:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * GET /reconciliation/health
 * Get reconciliation system health status
 */
router.get("/health", authenticate, authorize("admin", "super-admin"), async (req: Request, res: Response) => {
  try {
    const health = await adminReconciliationService.getHealthStatus();
    const queueStats = await getReconciliationQueueStats();

    res.json({
      success: true,
      data: {
        ...health,
        queue: queueStats,
      },
    });
  } catch (error) {
    logger.error("Failed to get health status:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /reconciliation/suspicious-patterns
 * Get suspicious patterns detected
 */
router.get(
  "/suspicious-patterns",
  authenticate,
  authorize("admin", "super-admin"),
  async (req: Request, res: Response) => {
    try {
      const patterns = await adminReconciliationService.getSuspiciousPatterns();

      res.json({
        success: true,
        data: patterns,
      });
    } catch (error) {
      logger.error("Failed to get suspicious patterns:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * GET /reconciliation/charts/history
 * Get historical chart data
 */
router.get(
  "/charts/history",
  authenticate,
  authorize("admin", "super-admin"),
  async (req: Request, res: Response) => {
    try {
      const { days = "30" } = req.query;

      const data = await reconciliationReportService.getHistoryChartData(parseInt(String(days), 10));

      res.json({
        success: true,
        data,
      });
    } catch (error) {
      logger.error("Failed to get chart data:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * GET /reconciliation/charts/severity
 * Get severity distribution chart
 */
router.get(
  "/charts/severity",
  authenticate,
  authorize("admin", "super-admin"),
  async (req: Request, res: Response) => {
    try {
      const data = await reconciliationReportService.getSeverityDistribution();

      res.json({
        success: true,
        data,
      });
    } catch (error) {
      logger.error("Failed to get severity chart:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * GET /reconciliation/charts/types
 * Get discrepancy type distribution
 */
router.get(
  "/charts/types",
  authenticate,
  authorize("admin", "super-admin"),
  async (req: Request, res: Response) => {
    try {
      const data = await reconciliationReportService.getTypeDistribution();

      res.json({
        success: true,
        data,
      });
    } catch (error) {
      logger.error("Failed to get type distribution:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

export default router;
