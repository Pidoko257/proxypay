import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import {
  resetCircuitBreaker,
  resetCircuitBreakerForProvider,
  getCircuitBreakerState,
  getCircuitBreakerCount,
} from "../utils/circuitBreaker";
import { logAuditEvent } from "../utils/log-audit-event";
import logger from "../utils/logger";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";

const router = Router();

const VALID_PROVIDERS = ["mtn", "airtel", "orange", "all"];

// Require admin authentication and admin privileges for all endpoints
router.use(requireAuth, requireAdmin);

/**
 * GET /status or GET /:provider/status
 * Check circuit breaker status
 */
router.get("/status", (_req: Request, res: Response) => {
  const operations = ["payment", "transfer", "payout"];
  const providers = ["mtn", "airtel", "orange"];

  const status: Record<string, Record<string, string>> = {};
  for (const prov of providers) {
    status[prov] = {};
    for (const op of operations) {
      status[prov][op] = getCircuitBreakerState(prov, op);
    }
  }

  return res.json({
    totalActiveBreakers: getCircuitBreakerCount(),
    providers: status,
  });
});

router.get("/:provider/status", (req: Request, res: Response) => {
  const provider = req.params.provider.toLowerCase();
  if (!VALID_PROVIDERS.includes(provider) && provider !== "all") {
    throw createError(
      ERROR_CODES.INVALID_INPUT,
      `Invalid provider: ${provider}. Valid values are: ${VALID_PROVIDERS.join(", ")}`
    );
  }

  const operations = ["payment", "transfer", "payout"];
  const status: Record<string, string> = {};
  for (const op of operations) {
    status[op] = getCircuitBreakerState(provider, op);
  }

  return res.json({
    provider,
    operations: status,
  });
});

/**
 * POST /:provider/reset or POST /reset
 * Manually reset circuit breaker for a provider with admin approval and audit trail logging
 */
export async function handleCircuitBreakerReset(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  try {
    const providerParam = req.params.provider || req.body.provider;
    if (!providerParam) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "Provider is required for circuit breaker reset"
      );
    }

    const provider = String(providerParam).toLowerCase();
    if (!VALID_PROVIDERS.includes(provider)) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        `Invalid provider: ${provider}. Valid values are: ${VALID_PROVIDERS.join(", ")}`
      );
    }

    const operation = req.body.operation ? String(req.body.operation).toLowerCase() : undefined;
    const reason = req.body.reason || "Manual admin override";
    const adminId = req.jwtUser?.userId || "unknown_admin";

    if (provider === "all") {
      for (const p of ["mtn", "airtel", "orange"]) {
        resetCircuitBreakerForProvider(p);
      }
    } else if (operation) {
      resetCircuitBreaker(provider, operation);
    } else {
      resetCircuitBreakerForProvider(provider);
    }

    // Write to audit trail
    await logAuditEvent(adminId, "CIRCUIT_BREAKER_MANUAL_RESET", {
      method: req.method,
      path: req.originalUrl,
      ipAddress: req.ip,
      userAgent: req.header("user-agent"),
      extra: {
        provider,
        operation: operation || "all",
        reason,
        resetAt: new Date().toISOString(),
      },
    });

    logger.warn(
      {
        adminId,
        provider,
        operation: operation || "all",
        reason,
      },
      `[circuit-breaker] Manual circuit breaker reset approved and executed for ${provider}`
    );

    return res.status(200).json({
      success: true,
      message: `Circuit breaker successfully reset for provider: ${provider}`,
      provider,
      operation: operation || "all",
      resetBy: adminId,
      reason,
      resetAt: new Date().toISOString(),
    });
  } catch (err) {
    return next(err);
  }
}

router.post("/:provider/reset", handleCircuitBreakerReset);
router.post("/reset", handleCircuitBreakerReset);

export default router;