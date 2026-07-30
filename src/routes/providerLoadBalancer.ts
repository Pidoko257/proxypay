/**
 * Provider Load Balancing API — Issue #203
 *
 * Endpoints:
 *   GET    /api/providers/load-balancer/config           — Get LB config
 *   PUT    /api/providers/load-balancer/config           — Update LB config
 *   GET    /api/providers/load-balancer/capacities       — Get provider capacities
 *   PUT    /api/providers/load-balancer/capacities/:name — Update provider capacity
 *   GET    /api/providers/load-balancer/metrics          — Load balancing metrics
 *   POST   /api/providers/load-balancer/route            — Simulate route decision
 *   POST   /api/providers/load-balancer/health/:name     — Update provider health status
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  providerLoadBalancer,
  ProviderName,
} from "../services/providerLoadBalancer";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Validation schemas
// ─────────────────────────────────────────────────────────────────────────────

const updateConfigSchema = z.object({
  strategy: z
    .enum(["round_robin", "least_connections", "weighted", "random"] as const)
    .optional(),
  healthCheckIntervalMs: z.number().int().min(1000).optional(),
  failureThreshold: z.number().int().min(1).optional(),
  recoveryThreshold: z.number().int().min(1).optional(),
  stickySessionTtlSeconds: z.number().int().min(0).optional(),
});

const updateCapacitySchema = z.object({
  maxConcurrentRequests: z.number().int().min(1).optional(),
  weight: z.number().int().min(1).max(100).optional(),
  isEnabled: z.boolean().optional(),
});

const updateHealthSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"] as const),
  avgResponseTimeMs: z.number().min(0).optional(),
});

const routeRequestSchema = z.object({
  sessionId: z.string().optional(),
});

const VALID_PROVIDERS: ProviderName[] = ["mtn", "airtel", "orange"];

function validateProvider(name: string): ProviderName {
  if (!VALID_PROVIDERS.includes(name as ProviderName)) {
    throw createError(
      ERROR_CODES.INVALID_INPUT,
      `Invalid provider: ${name}. Must be one of: ${VALID_PROVIDERS.join(", ")}`,
      { error: "Invalid provider name" },
    );
  }
  return name as ProviderName;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes — all require authentication + admin:system permission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/providers/load-balancer/config
 * Retrieve the current load balancing configuration.
 */
router.get(
  "/config",
  authenticateToken,
  requirePermission("admin:system"),
  async (_req: Request, res: Response) => {
    try {
      const config = await providerLoadBalancer.getLoadBalancerConfig();
      res.json({ success: true, data: config });
    } catch (error) {
      console.error("[LoadBalancer] get config error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to retrieve load balancer configuration",
      );
    }
  },
);

/**
 * PUT /api/providers/load-balancer/config
 * Update the load balancing configuration (strategy, thresholds, etc.).
 *
 * Body example:
 * {
 *   "strategy": "weighted",
 *   "healthCheckIntervalMs": 15000,
 *   "failureThreshold": 5,
 *   "stickySessionTtlSeconds": 600
 * }
 */
router.put(
  "/config",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const updates = updateConfigSchema.parse(req.body);
      const config = await providerLoadBalancer.updateLoadBalancerConfig(updates);
      res.json({ success: true, data: config, message: "Load balancer configuration updated" });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[LoadBalancer] update config error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to update load balancer configuration",
      );
    }
  },
);

/**
 * GET /api/providers/load-balancer/capacities
 * Retrieve capacity and health status for all providers.
 */
router.get(
  "/capacities",
  authenticateToken,
  requirePermission("admin:system"),
  async (_req: Request, res: Response) => {
    try {
      const capacities = await providerLoadBalancer.getProviderCapacities();
      res.json({ success: true, data: capacities });
    } catch (error) {
      console.error("[LoadBalancer] get capacities error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to retrieve provider capacities");
    }
  },
);

/**
 * PUT /api/providers/load-balancer/capacities/:name
 * Update capacity settings for a specific provider.
 *
 * Params:
 *   name — Provider name: mtn | airtel | orange
 *
 * Body example:
 * {
 *   "maxConcurrentRequests": 200,
 *   "weight": 50,
 *   "isEnabled": true
 * }
 */
router.put(
  "/capacities/:name",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const provider = validateProvider(req.params.name);
      const updates = updateCapacitySchema.parse(req.body);

      const capacity = await providerLoadBalancer.updateProviderCapacity(provider, updates);
      res.json({ success: true, data: capacity, message: `Capacity updated for ${provider}` });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[LoadBalancer] update capacity error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to update provider capacity");
    }
  },
);

/**
 * GET /api/providers/load-balancer/metrics
 * Retrieve load balancing metrics for all providers.
 *
 * Returns per-provider: request counts, failure counts, current load,
 * average response time, and health status.
 */
router.get(
  "/metrics",
  authenticateToken,
  requirePermission("admin:system"),
  async (_req: Request, res: Response) => {
    try {
      const metrics = await providerLoadBalancer.getMetrics();
      res.json({ success: true, data: metrics });
    } catch (error) {
      console.error("[LoadBalancer] get metrics error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to retrieve load balancer metrics");
    }
  },
);

/**
 * POST /api/providers/load-balancer/route
 * Simulate a routing decision without actually sending a request.
 * Useful for debugging and verification.
 *
 * Body:
 * { "sessionId": "optional-session-id" }
 */
router.post(
  "/route",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const { sessionId } = routeRequestSchema.parse(req.body);
      const decision = await providerLoadBalancer.selectProvider(sessionId);
      res.json({ success: true, data: decision });
    } catch (error: any) {
      if (error.message === "No healthy providers available") {
        throw createError(
          ERROR_CODES.SERVICE_UNAVAILABLE,
          "No healthy providers available for routing",
          { error: "All providers are currently unhealthy" },
        );
      }
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[LoadBalancer] route error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to determine route");
    }
  },
);

/**
 * POST /api/providers/load-balancer/health/:name
 * Manually update the health status of a specific provider.
 * Used by monitoring systems or manual intervention.
 *
 * Params:
 *   name — Provider name: mtn | airtel | orange
 *
 * Body:
 * { "status": "healthy" | "degraded" | "unhealthy", "avgResponseTimeMs": 250 }
 */
router.post(
  "/health/:name",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const provider = validateProvider(req.params.name);
      const { status, avgResponseTimeMs } = updateHealthSchema.parse(req.body);

      await providerLoadBalancer.updateProviderHealth(provider, status, avgResponseTimeMs);

      const capacities = await providerLoadBalancer.getProviderCapacities();
      const updated = capacities.find((c) => c.provider === provider);

      res.json({
        success: true,
        data: updated,
        message: `Health status for ${provider} updated to ${status}`,
      });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[LoadBalancer] update health error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to update provider health");
    }
  },
);

export default router;
