/**
 * Event Log Middleware
 *
 * Automatically logs HTTP requests, responses, and errors to NoSQL database.
 * Can be used for audit trails, compliance reporting, and debugging.
 */

import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger";
import { EventLogService } from "../services/eventLog/eventLogService";
import { EventCategory, EventSeverity } from "../services/eventLog/types";

// Paths to exclude from logging (health checks, metrics, etc.)
const EXCLUDED_PATHS = ["/health", "/metrics", "/ready", "/health/lb"];

/**
 * Event log middleware factory
 */
export function createEventLogMiddleware(eventLogService: EventLogService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip excluded paths
    if (EXCLUDED_PATHS.some((path) => req.path.startsWith(path))) {
      return next();
    }

    const startTime = Date.now();
    const requestId = (req as any).id || `${Date.now()}-${Math.random()}`;

    // Capture response finish
    const originalSend = res.send;
    let responseBody: any;

    res.send = function (data: any) {
      responseBody = data;
      return originalSend.call(this, data);
    };

    res.on("finish", async () => {
      try {
        const duration = Date.now() - startTime;
        const statusCode = res.statusCode;

        // Determine event severity
        let severity = EventSeverity.INFO;
        if (statusCode >= 500) {
          severity = EventSeverity.ERROR;
        } else if (statusCode >= 400) {
          severity = EventSeverity.WARNING;
        }

        // Extract key information
        const method = req.method;
        const path = req.path;
        const userId = (req as any).user?.id;
        const correlationId = (req as any).correlationId;

        // Log the request/response
        await eventLogService.log({
          category: EventCategory.AUDIT,
          type: "http.request",
          title: `${method} ${path} - ${statusCode}`,
          description: `HTTP request completed: ${method} ${path}`,
          severity,
          source: "http",
          metadata: {
            method,
            path,
            statusCode,
            durationMs: duration,
            requestId,
            ip: req.ip,
            userAgent: req.get("user-agent"),
            userId,
            isError: statusCode >= 400,
          },
          correlationId,
          userId,
          durationMs: duration,
          tags: [
            "http",
            method.toLowerCase(),
            `status-${statusCode}`,
            duration > 5000 ? "slow" : "fast",
          ],
        });
      } catch (error) {
        logger.error("Failed to log HTTP event", { error, requestId });
      }
    });

    // Handle errors
    const originalJson = res.json;
    res.json = function (data: any) {
      if (res.statusCode >= 400 && data.error) {
        // Will be logged by finish handler with severity
      }
      return originalJson.call(this, data);
    };

    next();
  };
}

/**
 * Log transaction events
 */
export async function logTransactionEvent(
  eventLogService: EventLogService,
  transactionId: string,
  type: string,
  status: "pending" | "completed" | "failed",
  data: Record<string, unknown>,
  userId?: string
) {
  const severity =
    status === "failed" ? EventSeverity.ERROR : EventSeverity.INFO;

  await eventLogService.log({
    category: EventCategory.TRANSACTION,
    type: `transaction.${type}.${status}`,
    title: `Transaction ${type.toUpperCase()} - ${status.toUpperCase()}`,
    description: `Transaction ${transactionId} ${type} ${status}`,
    severity,
    transactionId,
    userId,
    status,
    metadata: {
      type,
      status,
      ...data,
    },
    tags: ["transaction", type, status],
  });
}

/**
 * Log payment provider event
 */
export async function logProviderEvent(
  eventLogService: EventLogService,
  provider: string,
  type: string,
  status: "pending" | "completed" | "failed",
  transactionId: string,
  data: Record<string, unknown>,
  durationMs?: number
) {
  const severity =
    status === "failed" ? EventSeverity.WARNING : EventSeverity.INFO;

  await eventLogService.log({
    category: EventCategory.PROVIDER,
    type: `provider.${provider}.${type}.${status}`,
    title: `${provider.toUpperCase()} ${type.toUpperCase()} - ${status.toUpperCase()}`,
    description: `Provider ${provider} ${type} ${status}`,
    severity,
    providerId: provider,
    transactionId,
    status,
    durationMs,
    metadata: {
      provider,
      type,
      status,
      ...data,
    },
    tags: ["provider", provider, type, status],
  });
}

/**
 * Log security event
 */
export async function logSecurityEvent(
  eventLogService: EventLogService,
  type: string,
  severity: EventSeverity,
  userId: string,
  details: Record<string, unknown>
) {
  await eventLogService.log({
    category: EventCategory.SECURITY,
    type: `security.${type}`,
    title: `Security Event: ${type.toUpperCase()}`,
    description: `Security incident detected: ${type}`,
    severity,
    userId,
    metadata: {
      type,
      ...details,
    },
    tags: ["security", type, severity],
  });
}

/**
 * Log KYC/compliance event
 */
export async function logComplianceEvent(
  eventLogService: EventLogService,
  type: string,
  userId: string,
  details: Record<string, unknown>,
  status?: "pending" | "completed" | "failed"
) {
  const severity =
    status === "failed" ? EventSeverity.WARNING : EventSeverity.INFO;

  await eventLogService.log({
    category: EventCategory.COMPLIANCE,
    type: `compliance.${type}${status ? `.${status}` : ""}`,
    title: `Compliance: ${type.toUpperCase()}`,
    description: `Compliance check: ${type}`,
    severity,
    userId,
    status,
    metadata: {
      type,
      status,
      ...details,
    },
    tags: ["compliance", type, status || "pending"],
  });
}

/**
 * Request metrics for performance tracking
 */
export interface RequestMetrics {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  userId?: string;
  provider?: string;
  error?: string;
}

/**
 * Batch request logging (for high-volume scenarios)
 */
export async function batchLogRequests(
  eventLogService: EventLogService,
  metrics: RequestMetrics[]
) {
  const events = metrics.map((m) => ({
    category: EventCategory.AUDIT,
    type: "http.request.batch",
    title: `${m.method} ${m.path} - ${m.statusCode}`,
    description: `HTTP request: ${m.method} ${m.path}`,
    severity: m.statusCode >= 400 ? EventSeverity.WARNING : EventSeverity.INFO,
    source: "http",
    metadata: {
      method: m.method,
      path: m.path,
      statusCode: m.statusCode,
      durationMs: m.durationMs,
      provider: m.provider,
      error: m.error,
    },
    userId: m.userId,
    durationMs: m.durationMs,
    tags: ["http", m.method.toLowerCase(), `status-${m.statusCode}`],
  }));

  await eventLogService.logBatch(events);
}
