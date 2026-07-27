/**
 * Enhanced Timeout Middleware
 *
 * Replaces the minimal connect-timeout shim with:
 *  - Per-operation-type timeouts derived from `timeoutPolicies.ts`
 *  - Graceful cleanup on timeout (drains the socket, emits cleanup events)
 *  - Slow-request warning logging before the hard timeout fires
 *  - Prometheus metrics for timeouts and slow requests
 *  - Integration with timeoutService for alerting
 */

import { Request, Response, NextFunction } from "express";
import connectTimeout from "connect-timeout";
import logger from "../utils/logger";
import {
  OperationType,
  TimeoutPolicy,
  inferOperationType,
  resolvePolicy,
  TIMEOUT_POLICIES,
} from "../utils/timeoutPolicies";
import {
  timeoutTotal,
  slowRequestTotal,
  timeoutDurationSeconds,
} from "./timeoutMetrics";

// ---------------------------------------------------------------------------
// Legacy shim (kept for backwards compatibility)
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = "30s";

export function getTimeoutValue(): string {
  const timeoutMs = process.env.REQUEST_TIMEOUT_MS;
  if (timeoutMs) {
    return `${timeoutMs}ms`;
  }
  return DEFAULT_TIMEOUT;
}

export const globalTimeout = connectTimeout(getTimeoutValue());

/** Middleware: abort the request chain if connect-timeout has fired */
export const haltOnTimedout = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (!req.timedout) {
    next();
  }
};

/** Final error handler for 408 responses */
export const timeoutErrorHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (req.timedout) {
    logger.warn("Request timeout (connect-timeout)", {
      method: req.method,
      url: req.url,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    });
    res.status(408).json({
      error: "Request Timeout",
      message: "The request took too long to process",
      code: "REQUEST_TIMEOUT",
    });
    return;
  }
  next();
};

/**
 * Creates a connect-timeout middleware for a specific duration.
 */
export function customTimeout(timeoutMs: number) {
  return connectTimeout(`${timeoutMs}ms`);
}

/** Legacy presets */
export const TimeoutPresets = {
  quick: customTimeout(5_000),
  medium: customTimeout(15_000),
  standard: customTimeout(30_000),
  long: customTimeout(60_000),
  extended: customTimeout(120_000),
};

// ---------------------------------------------------------------------------
// New: per-operation-type graceful timeout middleware
// ---------------------------------------------------------------------------

/**
 * State attached to each request for cleanup tracking.
 */
interface TimeoutState {
  startedAt: number;
  warningTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
  operationType: OperationType;
  policy: TimeoutPolicy;
  timedOut: boolean;
}

const REQ_TIMEOUT_KEY = Symbol("timeoutState");

/**
 * Creates a middleware that:
 *  1. Detects the operation type from the request path/method.
 *  2. Sets a soft-warning timer that logs before the hard deadline.
 *  3. Sets a hard timer that sends a 408 and drains the connection.
 *  4. Records Prometheus metrics on completion / timeout / slow-request.
 *
 * Mount this **once** at the top of your Express app:
 *
 * ```ts
 * app.use(adaptiveTimeout());
 * ```
 *
 * For specific routes that need a different policy pass the OperationType:
 *
 * ```ts
 * router.post('/deposit', adaptiveTimeout(OperationType.PROVIDER_PAYMENT), handler);
 * ```
 */
export function adaptiveTimeout(
  forcedType?: OperationType,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const op = forcedType ?? inferOperationType(req.path, req.method);
    const policy = resolvePolicy(op);

    const state: TimeoutState = {
      startedAt: Date.now(),
      warningTimer: null,
      hardTimer: null,
      operationType: op,
      policy,
      timedOut: false,
    };

    // Attach state to request for downstream access
    (req as any)[REQ_TIMEOUT_KEY] = state;

    // --- Soft warning timer ---
    state.warningTimer = setTimeout(() => {
      const elapsed = Date.now() - state.startedAt;
      logger.warn("Slow request warning", {
        method: req.method,
        path: req.path,
        operationType: op,
        elapsedMs: elapsed,
        thresholdMs: policy.warningThresholdMs,
        timeoutMs: policy.timeoutMs,
        requestId: (req as any).id,
      });
      slowRequestTotal.inc({ operation_type: op });
    }, policy.warningThresholdMs);

    // --- Hard timeout timer ---
    state.hardTimer = setTimeout(async () => {
      state.timedOut = true;
      const elapsed = Date.now() - state.startedAt;

      logger.error("Request hard timeout", {
        method: req.method,
        path: req.path,
        operationType: op,
        elapsedMs: elapsed,
        timeoutMs: policy.timeoutMs,
        requestId: (req as any).id,
        alertOnTimeout: policy.alertOnTimeout,
      });

      timeoutTotal.inc({ operation_type: op, method: req.method });
      timeoutDurationSeconds.observe(
        { operation_type: op },
        elapsed / 1_000,
      );

      // Fire alert via timeout service (non-blocking)
      if (policy.alertOnTimeout) {
        try {
          const { timeoutService } = await import("../services/timeoutService");
          await timeoutService.recordTimeout({
            operationType: op,
            path: req.path,
            method: req.method,
            elapsedMs: elapsed,
            requestId: (req as any).id,
            transactionId: (req as any).transactionId,
          });
        } catch (alertErr) {
          logger.error("Failed to record timeout alert", { error: alertErr });
        }
      }

      // Graceful response
      if (!res.headersSent) {
        res.status(408).json({
          error: "Request Timeout",
          message: `The ${policy.label} operation timed out after ${policy.timeoutMs}ms`,
          code: "REQUEST_TIMEOUT",
          operationType: op,
          retryAfter: Math.ceil(policy.timeoutMs / 1_000),
        });
      }

      // Drain the underlying socket so keep-alive connections don't hang
      if (!res.writableEnded) {
        res.end();
      }
    }, policy.timeoutMs);

    // --- Cleanup when the response finishes normally ---
    const cleanup = (): void => {
      if (state.warningTimer) {
        clearTimeout(state.warningTimer);
        state.warningTimer = null;
      }
      if (state.hardTimer) {
        clearTimeout(state.hardTimer);
        state.hardTimer = null;
      }

      if (!state.timedOut) {
        const elapsed = Date.now() - state.startedAt;
        timeoutDurationSeconds.observe({ operation_type: op }, elapsed / 1_000);
      }
    };

    res.on("finish", cleanup);
    res.on("close", cleanup);

    next();
  };
}

/**
 * Returns the TimeoutState attached to a request, or undefined if
 * `adaptiveTimeout` was not used.
 */
export function getRequestTimeoutState(
  req: Request,
): TimeoutState | undefined {
  return (req as any)[REQ_TIMEOUT_KEY];
}

/**
 * Convenience factory: creates a per-route middleware for a known OperationType.
 *
 * @example
 * router.post('/deposit', operationTimeout(OperationType.PROVIDER_PAYMENT), handler);
 */
export function operationTimeout(
  op: OperationType,
): (req: Request, res: Response, next: NextFunction) => void {
  return adaptiveTimeout(op);
}

/**
 * Returns the resolved policy for a given OperationType, useful for tests and
 * administrative introspection.
 */
export function getPolicyForOperation(op: OperationType): TimeoutPolicy {
  return resolvePolicy(op);
}

/**
 * Returns all operation types and their resolved policies.
 */
export function getAllOperationPolicies(): Array<{
  operationType: OperationType;
  policy: TimeoutPolicy;
}> {
  return Object.values(OperationType).map((op) => ({
    operationType: op,
    policy: resolvePolicy(op),
  }));
}
