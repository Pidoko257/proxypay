/**
 * Trace propagation for BullMQ jobs.
 *
 * Injects the active OpenTelemetry span context into job data at enqueue time,
 * and restores it as a parent context when the worker processes the job.
 * Falls back gracefully when no active span exists.
 *
 * Log-correlation helpers (withTraceId / traceIdFromJob) are preserved for
 * compatibility with existing code.
 */

import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import { childLogger } from "../utils/logger";

/** Key under which W3C traceparent/tracestate are stored in job data. */
export const OTEL_CARRIER_KEY = "_otelCarrier" as const;
/** Legacy log-correlation key kept for back-compat. */
export const TRACE_ID_KEY = "_traceId" as const;

// ---------------------------------------------------------------------------
// Enqueue side
// ---------------------------------------------------------------------------

/**
 * Injects the active OTEL span context into `data` so the worker can restore
 * the parent trace link.  Also copies the request trace-id for log correlation.
 */
export function withTraceContext<T extends Record<string, unknown>>(
  data: T,
): T & { [OTEL_CARRIER_KEY]: Record<string, string> } {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return { ...data, [OTEL_CARRIER_KEY]: carrier };
}

/**
 * Legacy helper — kept for callers that already use withTraceId.
 * Adds both the log trace-id AND the OTEL carrier so either consumer works.
 */
export function withTraceId<T extends Record<string, unknown>>(
  req: { headers: Record<string, string | string[] | undefined> } | undefined,
  data: T,
): T & { [TRACE_ID_KEY]: string; [OTEL_CARRIER_KEY]: Record<string, string> } {
  const traceId =
    (req?.headers["x-trace-id"] as string | undefined) ??
    (req?.headers["x-request-id"] as string | undefined) ??
    crypto.randomUUID();

  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  return { ...data, [TRACE_ID_KEY]: traceId, [OTEL_CARRIER_KEY]: carrier };
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

/**
 * Runs `fn` inside a new span that is a child of the span context carried by
 * the job data.  If no carrier is present, the span starts as a root span.
 *
 * @param jobData   The `job.data` from a BullMQ worker processor.
 * @param spanName  Human-readable name for the worker span.
 * @param fn        The async job processing function.
 */
export async function runWithJobSpan<T>(
  jobData: Record<string, unknown>,
  spanName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const carrier = jobData[OTEL_CARRIER_KEY] as Record<string, string> | undefined;
  const parentCtx = carrier
    ? propagation.extract(context.active(), carrier)
    : context.active();

  const tracer = trace.getTracer("proxypay-workers");
  const span = tracer.startSpan(spanName, { kind: SpanKind.CONSUMER }, parentCtx);
  const ctx = trace.setSpan(parentCtx, span);

  return context.with(ctx, async () => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Log-correlation helpers (unchanged API)
// ---------------------------------------------------------------------------

export function traceIdFromJob(
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) return undefined;
  const val = data[TRACE_ID_KEY];
  return typeof val === "string" ? val : undefined;
}

export function childLoggerWithTrace(
  data: Record<string, unknown> | undefined,
) {
  const traceId = traceIdFromJob(data);
  return traceId ? childLogger(traceId) : undefined;
}
