/**
 * Trace-ID / Correlation-ID propagation for queue workers — issue #260
 *
 * Ensures that a correlation ID generated (or received) at the HTTP edge is
 * carried through every queue job so that worker logs can be correlated back
 * to the originating request in a single search query.
 *
 * Supported ID headers (priority order, highest first):
 *   1. x-correlation-id  — canonical header written by correlationId middleware
 *   2. x-trace-id        — legacy distributed-trace header
 *   3. x-request-id      — original request-id header
 *
 * Usage — enqueue side (inside a route handler or service):
 *   import { withTraceId } from "../queue/trace";
 *   await addTransactionJob(withTraceId(req, { transactionId, ... }));
 *
 * Usage — worker side:
 *   import { traceIdFromJob, childLoggerWithTrace } from "../queue/trace";
 *   const log = childLoggerWithTrace(job.data);
 *   log.info("processing job");
 */

import { childLogger } from "../utils/logger";

/** Key stored in job data to carry the correlation / trace ID. */
export const TRACE_ID_KEY = "_traceId" as const;

/**
 * Returns a shallow copy of `data` with the correlation ID extracted from the
 * incoming HTTP request appended.  Priority: x-correlation-id > x-trace-id >
 * x-request-id > req.correlationId > new UUID.
 *
 * `req` is typed loosely to avoid a hard dependency on express types and to
 * allow usage from non-Express contexts (e.g. provider callback handlers).
 */
export function withTraceId<T extends Record<string, unknown>>(
  req:
    | {
        headers?: Record<string, string | string[] | undefined>;
        correlationId?: string;
      }
    | undefined,
  data: T,
): T & { [TRACE_ID_KEY]: string } {
  const traceId =
    (req?.headers?.["x-correlation-id"] as string | undefined) ??
    (req?.headers?.["x-trace-id"] as string | undefined) ??
    (req?.headers?.["x-request-id"] as string | undefined) ??
    req?.correlationId ??
    crypto.randomUUID();

  return { ...data, [TRACE_ID_KEY]: traceId };
}

/**
 * Extracts the trace / correlation ID from a job data object (BullMQ
 * `job.data` or RabbitMQ message payload).  Returns `undefined` when the job
 * was enqueued before trace propagation was added so callers can fall back
 * gracefully.
 */
export function traceIdFromJob(
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) return undefined;
  const val = data[TRACE_ID_KEY];
  return typeof val === "string" ? val : undefined;
}

/**
 * Creates a child logger pre-bound to the trace / correlation ID carried by
 * the job data.  The returned logger emits `correlation_id` and `trace_id` on
 * every line so Loki / Grafana queries can filter across HTTP and queue layers
 * with a single label.
 *
 * Falls back to `undefined` when no trace ID is present — callers should use
 * the root logger in that case.
 */
export function childLoggerWithTrace(
  data: Record<string, unknown> | undefined,
) {
  const traceId = traceIdFromJob(data);
  if (!traceId) return undefined;
  // Emit both keys so existing dashboards using trace_id continue to work
  return childLogger(traceId, { correlation_id: traceId });
}
