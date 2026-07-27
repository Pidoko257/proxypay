/**
 * Query Logging Admin Routes
 *
 * API endpoints for monitoring database query performance.
 */

import { Router, Request, Response } from "express";
import { adminAuthMiddleware, rbacMiddleware } from "../../middleware/auth";
import { getQueryLogger } from "../../services/queryLogger/queryLoggerService";
import { QueryType, QueryStatus } from "../../services/queryLogger/types";
import logger from "../../utils/logger";

const router = Router();

// Apply authentication and RBAC
router.use(adminAuthMiddleware);
router.use(rbacMiddleware("admin:query_logging", ["read"]));

/**
 * GET /api/admin/query-logs
 * Get recent query logs with optional filtering
 */
router.get("/query-logs", async (req: Request, res: Response) => {
  try {
    const queryLogger = await getQueryLogger();
    if (!queryLogger) {
      return res.status(503).json({
        error: "Query logger not initialized",
      });
    }

    const {
      limit = 100,
      status,
      type,
      table,
      slowOnly = false,
      userId,
    } = req.query;

    const filter: any = {};

    if (status) {
      filter.status = status;
    }
    if (type) {
      filter.queryType = type;
    }
    if (table) {
      filter.table = table;
    }
    if (slowOnly === "true") {
      filter.isSlowQuery = true;
    }
    if (userId) {
      filter.userId = userId;
    }

    const logs = await queryLogger.getQueryLogs(filter, parseInt(limit as string));

    res.json({
      success: true,
      count: logs.length,
      logs,
    });
  } catch (error) {
    logger.error("Failed to get query logs", { error });
    res.status(500).json({
      error: "Failed to get query logs",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/admin/query-stats
 * Get query statistics and performance metrics
 */
router.get("/query-stats", async (req: Request, res: Response) => {
  try {
    const queryLogger = await getQueryLogger();
    if (!queryLogger) {
      return res.status(503).json({
        error: "Query logger not initialized",
      });
    }

    const stats = await queryLogger.getQueryStats();

    // Sort by execution count (most frequent)
    stats.sort((a, b) => b.executionCount - a.executionCount);

    res.json({
      success: true,
      count: stats.length,
      stats,
    });
  } catch (error) {
    logger.error("Failed to get query stats", { error });
    res.status(500).json({
      error: "Failed to get query stats",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/admin/query-stats/slow
 * Get slow query statistics
 */
router.get("/query-stats/slow", async (req: Request, res: Response) => {
  try {
    const queryLogger = await getQueryLogger();
    if (!queryLogger) {
      return res.status(503).json({
        error: "Query logger not initialized",
      });
    }

    const topN = parseInt((req.query.top as string) || "20");
    const slowQueries = await queryLogger.identifySlowQueries(topN);

    res.json({
      success: true,
      count: slowQueries.length,
      queries: slowQueries,
    });
  } catch (error) {
    logger.error("Failed to get slow queries", { error });
    res.status(500).json({
      error: "Failed to get slow queries",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/admin/query-stats/table/:table
 * Get query statistics for a specific table
 */
router.get("/query-stats/table/:table", async (req: Request, res: Response) => {
  try {
    const queryLogger = await getQueryLogger();
    if (!queryLogger) {
      return res.status(503).json({
        error: "Query logger not initialized",
      });
    }

    const { table } = req.params;
    const stats = await queryLogger.getQueryStatsByTable(table);

    res.json({
      success: true,
      table,
      count: stats.length,
      stats,
    });
  } catch (error) {
    logger.error("Failed to get table stats", { error });
    res.status(500).json({
      error: "Failed to get table stats",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/admin/query-analysis
 * Analyze query performance over time period
 */
router.get("/query-analysis", async (req: Request, res: Response) => {
  try {
    const queryLogger = await getQueryLogger();
    if (!queryLogger) {
      return res.status(503).json({
        error: "Query logger not initialized",
      });
    }

    const startDate = req.query.startDate
      ? new Date(req.query.startDate as string)
      : undefined;
    const endDate = req.query.endDate
      ? new Date(req.query.endDate as string)
      : undefined;

    const analysis = await queryLogger.analyzePerformance(startDate, endDate);

    res.json({
      success: true,
      period: {
        startDate: startDate || new Date(Date.now() - 24 * 60 * 60 * 1000),
        endDate: endDate || new Date(),
      },
      queryCount: analysis.length,
      analysis,
    });
  } catch (error) {
    logger.error("Failed to analyze queries", { error });
    res.status(500).json({
      error: "Failed to analyze queries",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/admin/query-performance-summary
 * Get comprehensive performance summary
 */
router.get("/query-performance-summary", async (req: Request, res: Response) => {
  try {
    const queryLogger = await getQueryLogger();
    if (!queryLogger) {
      return res.status(503).json({
        error: "Query logger not initialized",
      });
    }

    const startDate = req.query.startDate
      ? new Date(req.query.startDate as string)
      : undefined;
    const endDate = req.query.endDate
      ? new Date(req.query.endDate as string)
      : undefined;

    const summary = await queryLogger.getPerformanceSummary(startDate, endDate);

    res.json({
      success: true,
      summary,
    });
  } catch (error) {
    logger.error("Failed to get performance summary", { error });
    res.status(500).json({
      error: "Failed to get performance summary",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/admin/query-alerts
 * Get query performance alerts
 */
router.get("/query-alerts", async (req: Request, res: Response) => {
  try {
    const queryLogger = await getQueryLogger();
    if (!queryLogger) {
      return res.status(503).json({
        error: "Query logger not initialized",
      });
    }

    const unacknowledgedOnly = req.query.unacknowledged === "true";
    const alerts = await queryLogger.getAlerts(unacknowledgedOnly);

    res.json({
      success: true,
      count: alerts.length,
      alerts,
    });
  } catch (error) {
    logger.error("Failed to get alerts", { error });
    res.status(500).json({
      error: "Failed to get alerts",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/admin/query-alerts/:alertId/acknowledge
 * Acknowledge a query alert
 */
router.post(
  "/query-alerts/:alertId/acknowledge",
  async (req: Request, res: Response) => {
    try {
      const queryLogger = await getQueryLogger();
      if (!queryLogger) {
        return res.status(503).json({
          error: "Query logger not initialized",
        });
      }

      const { alertId } = req.params;
      await queryLogger.acknowledgeAlert(alertId);

      res.json({
        success: true,
        message: "Alert acknowledged",
      });
    } catch (error) {
      logger.error("Failed to acknowledge alert", { error });
      res.status(500).json({
        error: "Failed to acknowledge alert",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * GET /api/admin/query-optimization-suggestions
 * Get optimization suggestions
 */
router.get(
  "/query-optimization-suggestions",
  async (req: Request, res: Response) => {
    try {
      const queryLogger = await getQueryLogger();
      if (!queryLogger) {
        return res.status(503).json({
          error: "Query logger not initialized",
        });
      }

      const suggestions = await queryLogger.getOptimizationSuggestions();

      // Sort by priority
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      suggestions.sort(
        (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
      );

      res.json({
        success: true,
        count: suggestions.length,
        suggestions,
      });
    } catch (error) {
      logger.error("Failed to get optimization suggestions", { error });
      res.status(500).json({
        error: "Failed to get optimization suggestions",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * GET /api/admin/query-storage-stats
 * Get query logger storage statistics
 */
router.get("/query-storage-stats", async (req: Request, res: Response) => {
  try {
    const queryLogger = await getQueryLogger();
    if (!queryLogger) {
      return res.status(503).json({
        error: "Query logger not initialized",
      });
    }

    const stats = await queryLogger.getStorageStats();

    res.json({
      success: true,
      storage: {
        ...stats,
        sizeMB: (stats.sizeBytes / (1024 * 1024)).toFixed(2),
      },
    });
  } catch (error) {
    logger.error("Failed to get storage stats", { error });
    res.status(500).json({
      error: "Failed to get storage stats",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/admin/query-logs/clear
 * Clear old query logs
 */
router.post("/query-logs/clear", async (req: Request, res: Response) => {
  try {
    const queryLogger = await getQueryLogger();
    if (!queryLogger) {
      return res.status(503).json({
        error: "Query logger not initialized",
      });
    }

    const beforeDate = req.body.beforeDate
      ? new Date(req.body.beforeDate)
      : undefined;

    const deletedCount = await queryLogger.clearLogs(beforeDate);

    logger.info("Query logs cleared", {
      deletedCount,
      beforeDate,
      actor: (req as any).user?.id,
    });

    res.json({
      success: true,
      message: `Cleared ${deletedCount} query logs`,
      deletedCount,
    });
  } catch (error) {
    logger.error("Failed to clear logs", { error });
    res.status(500).json({
      error: "Failed to clear logs",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
