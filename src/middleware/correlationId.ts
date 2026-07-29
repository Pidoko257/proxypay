/**
 * Correlation ID Middleware — issue #260
 *
 * Generates or propagates a correlation ID for every incoming request so that
 * a single transaction can be traced across:
 *   - Express HTTP handlers
 *   - BullMQ / RabbitMQ queue workers
 *   - Provider callback handlers
 *   - Structured log lines
 *
 * Priority order for ID selection:
 *   1. x-correlation-id  — set by upstream gateways / load balancers
 *   2. x-trace-id        — legacy header (still honoured for backward compat)
 *   3. x-request-id      — set by the existing requestId middleware
 *   4. crypto.randomUUID() — generated fresh when none of the above are present
 *
 * The resolved ID is:
 *   - Written back onto req.correlationId (typed via express-augment.d.ts)
 *   - Echoed in the X-Correlation-ID response header so clients can
 *     reference it in support tickets
 *   - Attached to every log line via a child logger bound to the calling
 *     request (see logger.ts childLogger)
 *
 * No duplicate tracking: if `x-correlation-id` is already set upstream it is
 * reused as-is, preventing extra IDs from being minted for the same logical
 * request.
 *
 * Performance: the middleware does nothing heavier than a UUID v4 generation
 * (~1 µs) and a header read/write — well within the < 1% budget.
 */

import { randomUUID } from "crypto";
import { Request, Response, NextFunction } from "express";
import { childLogger } from "../utils/logger";

/** The canonical incoming header name (lowercase, as Node normalises them). */
export const CORRELATION_ID_HEADER = "x-correlation-id";

/** Response header echoed back to callers. */
export const CORRELATION_ID_RESPONSE_HEADER = "X-Correlation-ID";

/**
 * Resolves the correlation ID from the incoming request headers.
 * Returns a new UUID if none of the known trace headers are present.
 */
export function resolveCorrelationId(req: Request): string {
  return (
    (req.headers[CORRELATION_ID_HEADER] as string | undefined) ??
    (req.headers["x-trace-id"] as string | undefined) ??
    (req.headers["x-request-id"] as string | undefined) ??
    randomUUID()
  );
}

/**
 * Express middleware that attaches a correlation ID to every request.
 *
 * After this middleware runs:
 *   - `req.correlationId` is set to the resolved ID
 *   - `req.log` is set to a child logger pre-bound with `{ correlation_id }`
 *   - The `X-Correlation-ID` response header is written
 */
export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const correlationId = resolveCorrelationId(req);

  // Attach to request for downstream handlers and services
  (req as Request & { correlationId: string }).correlationId = correlationId;

  // Provide a bound child logger so handlers can log with the ID automatically
  (req as Request & { log: ReturnType<typeof childLogger> }).log =
    childLogger(correlationId, { correlation_id: correlationId });

  // Echo back so clients and API gateways can correlate their own traces
  res.setHeader(CORRELATION_ID_RESPONSE_HEADER, correlationId);

  next();
}
