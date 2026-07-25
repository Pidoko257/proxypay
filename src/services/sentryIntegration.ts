/**
 * Comprehensive Sentry integration service
 * Handles error tracking, context enrichment, and monitoring
 */

import * as Sentry from "@sentry/node";
import { Request, Response, NextFunction } from "express";
import { Transaction, TransactionStatus } from "../models/transaction";

export type ErrorSeverity = "fatal" | "error" | "warning" | "info";

interface ErrorContext {
  userId?: string;
  transactionId?: string;
  provider?: string;
  endpoint?: string;
  method?: string;
  statusCode?: number;
  duration?: number;
  metadata?: Record<string, any>;
}

/**
 * Attach comprehensive context to Sentry scope
 */
export function attachErrorContext(context: ErrorContext): void {
  const scope = Sentry.getCurrentScope();

  if (context.userId) {
    scope.setUser({ id: context.userId });
  }

  scope.setContext("error_context", {
    transactionId: context.transactionId,
    provider: context.provider,
    endpoint: context.endpoint,
    method: context.method,
    statusCode: context.statusCode,
    duration: context.duration,
    ...context.metadata,
  });
}

/**
 * Capture exception with proper context and severity
 */
export function captureError(
  error: Error | unknown,
  context: ErrorContext,
  severity: ErrorSeverity = "error",
): string | undefined {
  attachErrorContext(context);

  const scope = Sentry.getCurrentScope();
  scope.setLevel(severity);

  if (error instanceof Error) {
    return Sentry.captureException(error);
  }

  return Sentry.captureException(new Error(String(error)));
}

/**
 * Add transaction breadcrumb
 */
export function addTransactionBreadcrumb(
  transaction: Partial<Transaction>,
  action: "created" | "updated" | "completed" | "failed",
): void {
  Sentry.addBreadcrumb({
    category: "transaction",
    message: `Transaction ${action}: ${transaction.id}`,
    level: "info",
    data: {
      id: transaction.id,
      status: transaction.status,
      type: transaction.type,
      amount: transaction.amount,
      provider: transaction.provider,
      action,
    },
  });
}

/**
 * Add provider API call breadcrumb
 */
export function addProviderAPIBreadcrumb(
  provider: string,
  endpoint: string,
  method: string,
  statusCode?: number,
  duration?: number,
): void {
  Sentry.addBreadcrumb({
    category: "provider_api",
    message: `${provider} ${method} ${endpoint}`,
    level: statusCode && statusCode >= 400 ? "warning" : "info",
    data: {
      provider,
      endpoint,
      method,
      statusCode,
      duration,
    },
  });
}

/**
 * Add database query breadcrumb
 */
export function addDatabaseBreadcrumb(
  query: string,
  duration: number,
  error?: Error,
): void {
  Sentry.addBreadcrumb({
    category: "database",
    message: `Query executed in ${duration}ms`,
    level: error ? "warning" : "debug",
    data: {
      query: query.substring(0, 200), // Truncate long queries
      duration,
      error: error?.message,
    },
  });
}

/**
 * Middleware to capture request context and errors
 */
export function sentryErrorCaptureMiddleware(
  err: Error,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const context: ErrorContext = {
    endpoint: _req.path,
    method: _req.method,
    userId: (_req as any).user?.id,
    statusCode: _res.statusCode,
  };

  const severity = _res.statusCode && _res.statusCode >= 500 ? "error" : "warning";
  captureError(err, context, severity as ErrorSeverity);

  next(err);
}

/**
 * Determine if error should be sampled (filtered)
 */
export function shouldSampleError(statusCode?: number, message?: string): boolean {
  // Skip 404 errors
  if (statusCode === 404) return false;

  // Skip timeout errors (usually expected in distributed systems)
  if (message?.includes("timeout")) return false;

  // Skip intentional client errors
  if (statusCode === 400 || statusCode === 401 || statusCode === 403) return false;

  // Capture everything else
  return true;
}

/**
 * Set up error grouping fingerprint for better error aggregation
 */
export function setErrorFingerprint(
  error: Error,
  provider?: string,
  errorType?: string,
): void {
  const scope = Sentry.getCurrentScope();

  const fingerprint = [
    errorType || "unknown",
    provider || "general",
    error.message?.split("\n")[0],
  ];

  scope.setFingerprint(fingerprint);
}

/**
 * Capture critical mobile money provider errors
 */
export function captureProviderError(
  provider: string,
  error: Error,
  context?: Record<string, any>,
): void {
  const scope = Sentry.getCurrentScope();
  scope.setLevel("error");

  scope.setContext("provider_error", {
    provider,
    message: error.message,
    ...context,
  });

  setErrorFingerprint(error, provider, "provider_error");
  Sentry.captureException(error);
}

/**
 * Capture AML/compliance-related errors
 */
export function captureComplianceError(
  error: Error,
  userId?: string,
  reason?: string,
): void {
  const scope = Sentry.getCurrentScope();
  scope.setLevel("warning");

  scope.setContext("compliance_error", {
    userId,
    reason,
    timestamp: new Date().toISOString(),
  });

  setErrorFingerprint(error, "compliance", "compliance_alert");
  Sentry.captureException(error);
}

/**
 * Initialize global error handlers
 */
export function initializeGlobalErrorHandlers(): void {
  // Capture uncaught exceptions
  process.on("uncaughtException", (error: Error) => {
    console.error("Uncaught Exception:", error);

    const scope = Sentry.getCurrentScope();
    scope.setLevel("fatal");
    scope.setContext("uncaught_exception", {
      timestamp: new Date().toISOString(),
    });

    Sentry.captureException(error);

    // Give Sentry time to send, then exit
    setTimeout(() => process.exit(1), 2000);
  });

  // Capture unhandled promise rejections
  process.on("unhandledRejection", (reason: any) => {
    console.error("Unhandled Rejection:", reason);

    const error =
      reason instanceof Error ? reason : new Error(String(reason));

    const scope = Sentry.getCurrentScope();
    scope.setLevel("error");
    scope.setContext("unhandled_rejection", {
      reason: String(reason),
      timestamp: new Date().toISOString(),
    });

    Sentry.captureException(error);
  });
}

/**
 * Flush Sentry and wait for events to be sent
 */
export async function flushSentry(timeout: number = 2000): Promise<boolean> {
  try {
    return await Sentry.close(timeout);
  } catch (error) {
    console.error("Failed to flush Sentry:", error);
    return false;
  }
}
