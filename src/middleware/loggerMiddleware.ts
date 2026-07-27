import { Request, Response, NextFunction } from 'express';
import { structuredLogger } from '../utils/structuredLogger';
import { v4 as uuidv4 } from 'uuid';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      traceId?: string;
      userId?: string;
      logger?: ReturnType<typeof structuredLogger.createChild>;
      startTime?: number;
    }
  }
}

/**
 * Logger middleware that injects request context
 */
export function loggerMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Generate or extract request ID
    const requestId =
      (req.headers['x-request-id'] as string) || `req-${Date.now()}-${uuidv4().slice(0, 8)}`;
    req.requestId = requestId;

    // Extract trace ID for distributed tracing
    const traceId = (req.headers['x-trace-id'] as string) || requestId;
    req.traceId = traceId;

    // Extract user ID from JWT if available
    extractUserIdFromJWT(req);

    // Create child logger with request context
    req.logger = structuredLogger.createChild({
      requestId,
      traceId,
      userId: req.userId,
    });

    // Record start time for duration calculation
    req.startTime = Date.now();

    // Log request entry
    req.logger.info(
      {
        method: req.method,
        path: req.path,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      },
      'Request received'
    );

    // Store original send function
    const originalSend = res.send.bind(res);
    let responseBody: any;

    res.send = function (data: any) {
      responseBody = data;
      return originalSend(data);
    } as any;

    // Log response on finish
    res.on('finish', () => {
      const duration = Date.now() - (req.startTime || Date.now());
      const contentLength = res.get('content-length') || 0;

      req.logger?.info(
        {
          statusCode: res.statusCode,
          duration_ms: duration,
          contentLength,
        },
        'Request completed'
      );
    });

    next();
  };
}

/**
 * Extract user ID from JWT token in Authorization header
 */
function extractUserIdFromJWT(req: Request): void {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return;
    }

    const token = authHeader.slice(7);
    // Decode JWT without verification (best effort)
    const parts = token.split('.');
    if (parts.length !== 3) {
      return;
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64').toString('utf-8')
    );

    if (payload.sub || payload.userId || payload.id) {
      req.userId = payload.sub || payload.userId || payload.id;
    }
  } catch (error) {
    // Silently ignore JWT parsing errors
  }
}

/**
 * Error logging middleware for uncaught errors
 */
export function errorLoggerMiddleware() {
  return (err: any, req: Request, res: Response, next: NextFunction) => {
    const duration = Date.now() - (req.startTime || Date.now());

    req.logger?.error(
      {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        statusCode: err.statusCode || 500,
        duration_ms: duration,
      },
      'Request error'
    );

    next(err);
  };
}

/**
 * Helper: log with request context
 */
export function logWithContext(
  req: Request,
  level: 'info' | 'debug' | 'warn' | 'error',
  data: Record<string, any>,
  message: string
): void {
  if (!req.logger) {
    structuredLogger[level](data, message);
    return;
  }

  req.logger[level](data, message);
}

/**
 * Helper: log performance metric
 */
export function logPerformance(
  req: Request,
  operation: string,
  durationMs: number,
  data?: Record<string, any>
): void {
  req.logger?.info(
    {
      operation,
      duration_ms: durationMs,
      ...data,
    },
    'Performance metric'
  );
}

/**
 * Helper: log security event
 */
export function logSecurityEvent(
  req: Request,
  eventType: string,
  data?: Record<string, any>
): void {
  req.logger?.security(
    {
      event_type: eventType,
      ...data,
    },
    `Security event: ${eventType}`
  );
}

/**
 * Helper: log audit event
 */
export function logAuditEvent(
  req: Request,
  eventType: string,
  data?: Record<string, any>
): void {
  req.logger?.audit(
    {
      event_type: eventType,
      ...data,
    },
    `Audit event: ${eventType}`
  );
}

/**
 * Ensure logger is attached to request
 */
export function attachLogger() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.logger) {
      req.requestId = req.requestId || `req-${Date.now()}-${uuidv4().slice(0, 8)}`;
      req.logger = structuredLogger.createChild({
        requestId: req.requestId,
        userId: req.userId,
      });
    }
    next();
  };
}
