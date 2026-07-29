import { Request, Response, NextFunction } from "express";
import tracer, { extractTraceContext, injectTraceContext } from "../tracer";

export interface TracedRequest extends Request {
  traceId?: string;
}

/**
 * Middleware that extracts trace headers from incoming requests (e.g. from Go ingest service or API Gateway),
 * creates a root/child span for the request, and injects trace headers for outgoing requests.
 */
export function tracingMiddleware(req: TracedRequest, res: Response, next: NextFunction): void {
  const childOf = extractTraceContext(req.headers as any);
  const path = req.path || req.url;
  const method = req.method;

  const span = tracer.startSpan("express.request", {
    childOf: childOf || undefined,
    tags: {
      "http.method": method,
      "http.url": path,
      "component": "express",
      "service.name": "proxypay-express-api",
    },
  });

  const traceId = (span.context() as any).toTraceId
    ? (span.context() as any).toTraceId()
    : req.headers["x-trace-id"] || `${Date.now()}`;

  req.traceId = String(traceId);
  res.setHeader("x-trace-id", String(traceId));

  // Attach trace propagation helper to res.locals for client calls
  res.locals.injectTraceContext = (headers: Record<string, string> = {}) => {
    tracer.inject(span, "http_headers", headers);
    return headers;
  };

  res.on("finish", () => {
    span.setTag("http.status_code", res.statusCode);
    if (res.statusCode >= 400) {
      span.setTag("error", true);
    }
    span.finish();
  });

  tracer.scope().activate(span, () => {
    next();
  });
}
