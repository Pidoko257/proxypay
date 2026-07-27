import { Request, Response, NextFunction } from 'express';
import { getIdempotencyService } from '../services/idempotencyService';
import { structuredLogger } from '../utils/structuredLogger';

/**
 * Express middleware for idempotency key support
 * Prevents duplicate request processing by caching responses
 */
export function idempotencyMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Only apply to POST, PUT, PATCH requests
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      return next();
    }

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (!idempotencyKey) {
      return next();
    }

    try {
      const idempotencyService = getIdempotencyService();
      const cached = await idempotencyService.getIdempotencyKey(idempotencyKey);

      if (cached) {
        structuredLogger.info(
          {
            idempotencyKey,
            statusCode: cached.statusCode,
            requestId: cached.requestId,
          },
          'Idempotent request cache hit'
        );

        res.setHeader('X-Idempotency-Cached', 'true');
        res.setHeader(
          'X-Idempotency-Cached-At',
          cached.createdAt.toISOString()
        );
        res.setHeader('X-Original-Request-Id', cached.requestId);

        return res.status(cached.statusCode || 200).json(cached.response);
      }
    } catch (error) {
      structuredLogger.warn(
        {
          idempotencyKey,
          error: error instanceof Error ? error.message : String(error),
        },
        'Idempotency check failed, proceeding normally'
      );
      // Continue to next middleware if error
    }

    // Store original send function
    const originalSend = res.json.bind(res);

    // Override json method to capture response
    res.json = function (data: any) {
      try {
        const idempotencyService = getIdempotencyService();
        const statusCode = res.statusCode;

        // Only cache successful responses (2xx)
        if (statusCode >= 200 && statusCode < 300) {
          idempotencyService
            .storeIdempotencyKey(
              idempotencyKey,
              req.id || req.requestId || 'unknown',
              data,
              statusCode
            )
            .catch((err) => {
              structuredLogger.warn(
                {
                  idempotencyKey,
                  error: err instanceof Error ? err.message : String(err),
                },
                'Failed to store idempotency response'
              );
            });

          res.setHeader('X-Idempotency-Key', idempotencyKey);
        }
      } catch (error) {
        structuredLogger.warn(
          {
            idempotencyKey,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error storing idempotency response'
        );
      }

      return originalSend(data);
    } as any;

    next();
  };
}
