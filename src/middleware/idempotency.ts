/**
 * Idempotency middleware for safe transaction retries
 * Caches responses and returns cached result for duplicate requests
 */

import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { redisClient } from "../config/redis";
import { logger } from "../utils/logger";

// UUID v4 format validation
const IdempotencyKeySchema = z
  .string()
  .uuid("Invalid idempotency key format. Must be a valid UUID v4")
  .max(255);

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const CACHE_KEY_PREFIX = "idempotency:response";

interface IdempotencyCache {
  statusCode: number;
  headers: Record<string, string>;
  body: any;
  timestamp: number;
}

/**
 * Extracts and validates idempotency key from request header
 */
export function extractIdempotencyKey(req: Request): string | null {
  const key = req.header("Idempotency-Key")?.trim();

  if (!key) {
    return null;
  }

  try {
    return IdempotencyKeySchema.parse(key);
  } catch (error) {
    const message =
      error instanceof z.ZodError && error.errors.length > 0
        ? error.errors[0].message
        : String(error);
    throw new Error(`Invalid Idempotency-Key format: ${message}`);
  }
}

/**
 * Generate cache key for idempotency response
 */
function getCacheKey(idempotencyKey: string, userId?: string): string {
  return `${CACHE_KEY_PREFIX}:${userId || "anonymous"}:${idempotencyKey}`;
}

/**
 * Store response in idempotency cache
 */
export async function cacheIdempotencyResponse(
  idempotencyKey: string,
  statusCode: number,
  responseBody: any,
  userId?: string,
): Promise<void> {
  try {
    const cacheKey = getCacheKey(idempotencyKey, userId);
    const cacheData: IdempotencyCache = {
      statusCode,
      headers: {
        "x-idempotency-cached": "true",
        "x-idempotency-key": idempotencyKey,
      },
      body: responseBody,
      timestamp: Date.now(),
    };

    await redisClient.setex(
      cacheKey,
      IDEMPOTENCY_TTL_SECONDS,
      JSON.stringify(cacheData),
    );

    logger.info("Idempotency response cached", {
      idempotencyKey,
      statusCode,
      ttl: IDEMPOTENCY_TTL_SECONDS,
    });
  } catch (error) {
    logger.error("Failed to cache idempotency response", {
      error: String(error),
      idempotencyKey,
    });
    // Don't throw - cache failures shouldn't break the request
  }
}

/**
 * Retrieve cached response for idempotency key
 */
export async function getIdempotencyResponse(
  idempotencyKey: string,
  userId?: string,
): Promise<IdempotencyCache | null> {
  try {
    const cacheKey = getCacheKey(idempotencyKey, userId);
    const cached = await redisClient.get(cacheKey);

    if (!cached) {
      return null;
    }

    const data: IdempotencyCache = JSON.parse(cached);
    logger.info("Idempotency cache hit", {
      idempotencyKey,
      age: Date.now() - data.timestamp,
    });

    return data;
  } catch (error) {
    logger.warn("Failed to retrieve idempotency response", {
      error: String(error),
      idempotencyKey,
    });
    return null;
  }
}

/**
 * Clear idempotency cache (for testing or admin operations)
 */
export async function clearIdempotencyCache(
  idempotencyKey: string,
  userId?: string,
): Promise<void> {
  try {
    const cacheKey = getCacheKey(idempotencyKey, userId);
    await redisClient.del(cacheKey);
  } catch (error) {
    logger.warn("Failed to clear idempotency cache", { error: String(error) });
  }
}

/**
 * Middleware to handle idempotency for POST requests
 * Checks for cached response and returns it, or stores response after processing
 */
export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Only apply to POST and PUT requests
  if (req.method !== "POST" && req.method !== "PUT") {
    return next();
  }

  let idempotencyKey: string | null = null;

  try {
    idempotencyKey = extractIdempotencyKey(req);
  } catch (error) {
    return res.status(400).json({
      error: "INVALID_IDEMPOTENCY_KEY",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // If no idempotency key provided, continue normally
  if (!idempotencyKey) {
    return next();
  }

  // Store idempotency key and userId on request for later use
  (req as any).idempotencyKey = idempotencyKey;
  (req as any).idempotencyUserId = (req as any).user?.id;

  // Check for cached response
  getIdempotencyResponse(idempotencyKey, (req as any).user?.id)
    .then((cached) => {
      if (cached) {
        // Return cached response
        return res
          .status(cached.statusCode)
          .set(cached.headers)
          .json(cached.body);
      }

      // Intercept response to cache it
      const originalJson = res.json.bind(res);

      res.json = function (body: any) {
        // Only cache successful responses (2xx)
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cacheIdempotencyResponse(
            idempotencyKey!,
            res.statusCode,
            body,
            (req as any).user?.id,
          ).catch((error) =>
            logger.error("Failed to cache idempotency response", {
              error: String(error),
            }),
          );
        }

        return originalJson(body);
      };

      next();
    })
    .catch((error) => {
      logger.error("Idempotency middleware error", { error: String(error) });
      // Continue without caching on error
      next();
    });
}

/**
 * Cleanup job to remove expired idempotency cache entries
 * Should be scheduled to run periodically (e.g., daily)
 */
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  try {
    // Redis automatically removes expired keys with SETEX
    // This is a no-op but can be extended for custom cleanup logic
    logger.info("Idempotency key cleanup executed");
    return 0;
  } catch (error) {
    logger.error("Failed to cleanup expired idempotency keys", {
      error: String(error),
    });
    throw error;
  }
}
