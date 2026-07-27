/**
 * Circuit Breaker Admin Routes
 *
 * Endpoints for monitoring and managing circuit breaker state
 */

import { Router, Request, Response } from "express";
import { adminAuthMiddleware, rbacMiddleware } from "../../middleware/auth";
import {
  getCircuitBreakerStatus,
  getProviderCircuitBreakerStatuses,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
  getCircuitBreakerMetrics,
} from "../../utils/circuitBreakerEnhanced";
import logger from "../../utils/logger";

const router = Router();

// Apply authentication and RBAC middleware
router.use(adminAuthMiddleware);
router.use(rbacMiddleware("admin:circuit_breaker", ["read", "write"]));

/**
 * GET /api/admin/circuit-breaker/status
 * Get status of a specific circuit breaker
 *
 * Query params:
 * - provider (required): Provider name (mtn, airtel, orange)
 * - operation (required): Operation name (sendPayout, requestPayment, etc.)
 */
router.get("/status", (req: Request, res: Response) => {
  try {
    const { provider, operation } = req.query;

    if (!provider || !operation) {
      return res.status(400).json({
        error: "MISSING_PARAMS",
        message:
          "Both 'provider' and 'operation' query parameters are required",
      });
    }

    const status = getCircuitBreakerStatus(
      String(provider),
      String(operation)
    );

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    logger.error("Error fetching circuit breaker status", { error });
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to fetch circuit breaker status",
    });
  }
});

/**
 * GET /api/admin/circuit-breaker/provider/:provider
 * Get all circuit breaker statuses for a specific provider
 *
 * Params:
 * - provider (required): Provider name (mtn, airtel, orange)
 */
router.get("/provider/:provider", (req: Request, res: Response) => {
  try {
    const { provider } = req.params;

    const statuses = getProviderCircuitBreakerStatuses(provider);

    res.json({
      success: true,
      provider,
      count: statuses.length,
      data: statuses,
    });
  } catch (error) {
    logger.error("Error fetching provider circuit breaker statuses", {
      error,
      provider: req.params.provider,
    });
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to fetch provider circuit breaker statuses",
    });
  }
});

/**
 * GET /api/admin/circuit-breaker/all
 * Get all circuit breaker statuses for all providers
 */
router.get("/all", (req: Request, res: Response) => {
  try {
    const metrics = getCircuitBreakerMetrics();

    const summary = {
      totalCircuitBreakers: Object.values(metrics).reduce(
        (sum, statuses) => sum + statuses.length,
        0
      ),
      openCount: Object.values(metrics).reduce(
        (sum, statuses) =>
          sum + statuses.filter((s) => s.state === "open").length,
        0
      ),
      halfOpenCount: Object.values(metrics).reduce(
        (sum, statuses) =>
          sum + statuses.filter((s) => s.state === "half-open").length,
        0
      ),
      closedCount: Object.values(metrics).reduce(
        (sum, statuses) =>
          sum + statuses.filter((s) => s.state === "closed").length,
        0
      ),
    };

    res.json({
      success: true,
      summary,
      data: metrics,
    });
  } catch (error) {
    logger.error("Error fetching all circuit breaker statuses", { error });
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to fetch circuit breaker statuses",
    });
  }
});

/**
 * POST /api/admin/circuit-breaker/reset
 * Reset a specific circuit breaker
 *
 * Request body:
 * {
 *   "provider": "mtn",
 *   "operation": "sendPayout"
 * }
 */
router.post("/reset", (req: Request, res: Response) => {
  try {
    const { provider, operation } = req.body;

    if (!provider || !operation) {
      return res.status(400).json({
        error: "MISSING_FIELDS",
        message: "Both 'provider' and 'operation' are required",
      });
    }

    const statusBefore = getCircuitBreakerStatus(provider, operation);
    resetCircuitBreaker(provider, operation);
    const statusAfter = getCircuitBreakerStatus(provider, operation);

    logger.info("Circuit breaker reset", {
      provider,
      operation,
      stateBefore: statusBefore.state,
      stateAfter: statusAfter.state,
      actor: req.user?.id,
    });

    res.json({
      success: true,
      message: `Circuit breaker for ${provider}:${operation} has been reset`,
      before: statusBefore,
      after: statusAfter,
    });
  } catch (error) {
    logger.error("Error resetting circuit breaker", {
      error,
      body: req.body,
    });
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to reset circuit breaker",
    });
  }
});

/**
 * POST /api/admin/circuit-breaker/reset-provider
 * Reset all circuit breakers for a specific provider
 *
 * Request body:
 * {
 *   "provider": "mtn"
 * }
 */
router.post("/reset-provider", (req: Request, res: Response) => {
  try {
    const { provider } = req.body;

    if (!provider) {
      return res.status(400).json({
        error: "MISSING_FIELDS",
        message: "'provider' field is required",
      });
    }

    const statusesBefore = getProviderCircuitBreakerStatuses(provider);
    resetAllCircuitBreakers(provider);
    const statusesAfter = getProviderCircuitBreakerStatuses(provider);

    logger.info("All circuit breakers reset for provider", {
      provider,
      count: statusesBefore.length,
      actor: req.user?.id,
    });

    res.json({
      success: true,
      message: `${statusesBefore.length} circuit breakers for ${provider} have been reset`,
      before: statusesBefore,
      after: statusesAfter,
    });
  } catch (error) {
    logger.error("Error resetting provider circuit breakers", {
      error,
      provider: req.body.provider,
    });
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to reset provider circuit breakers",
    });
  }
});

/**
 * GET /api/admin/circuit-breaker/health
 * Health check summary of all providers
 */
router.get("/health", (req: Request, res: Response) => {
  try {
    const metrics = getCircuitBreakerMetrics();

    const health: Record<
      string,
      {
        status: "healthy" | "degraded" | "critical";
        openCircuits: number;
        halfOpenCircuits: number;
        totalFailures: number;
      }
    > = {};

    for (const [provider, statuses] of Object.entries(metrics)) {
      const openCount = statuses.filter((s) => s.state === "open").length;
      const halfOpenCount = statuses.filter(
        (s) => s.state === "half-open"
      ).length;
      const totalFailures = statuses.reduce((sum, s) => sum + s.failureCount, 0);

      let status: "healthy" | "degraded" | "critical";
      if (openCount === 0 && halfOpenCount === 0) {
        status = "healthy";
      } else if (openCount === 0) {
        status = "degraded";
      } else {
        status = "critical";
      }

      health[provider] = {
        status,
        openCircuits: openCount,
        halfOpenCircuits: halfOpenCount,
        totalFailures,
      };
    }

    const overallStatus = Object.values(health).some((h) => h.status === "critical")
      ? "critical"
      : Object.values(health).some((h) => h.status === "degraded")
        ? "degraded"
        : "healthy";

    res.json({
      success: true,
      overallStatus,
      providers: health,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Error fetching circuit breaker health", { error });
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to fetch circuit breaker health",
    });
  }
});

export default router;
