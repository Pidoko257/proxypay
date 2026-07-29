import tracer from "dd-trace";
import { traceSpansTotal, activeTracesGauge } from "./utils/metrics";

const serviceName = process.env.SERVICE_NAME || "proxypay-express-api";
const env = process.env.NODE_ENV || "development";
const sampleRate = Number(process.env.TRACE_SAMPLE_RATE || "1.0");

// Initialize Datadog / OpenTelemetry compatible tracer with sampling & log injection
tracer.init({
  logInjection: true,
  env,
  service: serviceName,
  sampleRate,
  runtimeMetrics: true,
});

export interface TraceHeaders {
  "x-trace-id"?: string;
  "x-parent-id"?: string;
  "x-datadog-trace-id"?: string;
  "x-datadog-parent-id"?: string;
  "x-datadog-sampling-priority"?: string;
  traceparent?: string;
  [key: string]: string | undefined;
}

/**
 * Injects trace headers into outgoing HTTP headers object for cross-service request propagation.
 */
export function injectTraceContext(headers: Record<string, string> = {}): Record<string, string> {
  const span = tracer.scope().active();
  if (span) {
    tracer.inject(span, "http_headers", headers);
  } else {
    const traceId = `${Math.floor(Math.random() * 1000000000000000000)}`;
    const spanId = `${Math.floor(Math.random() * 1000000000000000000)}`;
    headers["x-trace-id"] = traceId;
    headers["x-datadog-trace-id"] = traceId;
    headers["x-datadog-parent-id"] = spanId;
    headers["traceparent"] = `00-${traceId.padStart(32, "0")}-${spanId.padStart(16, "0")}-01`;
  }
  return headers;
}

/**
 * Extracts trace context from incoming HTTP request headers.
 */
export function extractTraceContext(headers: TraceHeaders) {
  try {
    return tracer.extract("http_headers", headers as Record<string, string>);
  } catch (err) {
    return null;
  }
}

/**
 * Custom span helper to measure service-level timing breakdown across components.
 */
export async function traceSpan<T>(
  operationName: string,
  fn: (span: any) => Promise<T>,
  resource?: string,
): Promise<T> {
  activeTracesGauge.inc({ service: serviceName });
  traceSpansTotal.inc({ service: serviceName, operation: operationName });

  return tracer.trace(operationName, { resource: resource || operationName }, async (span) => {
    try {
      return await fn(span);
    } finally {
      activeTracesGauge.dec({ service: serviceName });
    }
  });
}

export default tracer;
