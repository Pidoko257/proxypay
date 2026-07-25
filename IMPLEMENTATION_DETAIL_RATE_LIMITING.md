# Task #156 - Distributed Rate Limiting Implementation Guide

## File Structure

```
src/middleware/rateLimiters/
├── index.ts              # Main middleware exports
├── engine.ts             # Redis-backed rate limiting core
├── config.ts             # Rate limit configurations
├── whitelist.ts          # IP/API key whitelist
├── logger.ts             # Violation logging
├── metrics.ts            # Prometheus metrics
└── __tests__/
    ├── engine.test.ts
    ├── config.test.ts
    └── integration.test.ts
```

## 1. Rate Limiting Engine (engine.ts)

```typescript
import { Request, Response, NextFunction } from "express";
import { redisClient } from "../../config/redis";
import { logger } from "../../services/logger";

export interface RateLimitOptions {
  keyPrefix: string;
  limit: number;
  windowMs: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  maxWaitTime?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

/**
 * Redis-backed rate limiter
 * Supports horizontal scaling and distributed systems
 */
export class RateLimiter {
  private options: RateLimitOptions;

  constructor(options: RateLimitOptions) {
    this.options = options;
  }

  /**
   * Check if request is allowed
   * Uses Redis INCR + EXPIRE for atomic operations
   */
  async checkLimit(identifier: string): Promise<RateLimitResult> {
    const key = `${this.options.keyPrefix}:${identifier}`;
    const now = Math.floor(Date.now() / 1000);
    const windowEnd = now + Math.ceil(this.options.windowMs / 1000);

    try {
      // Atomic increment and get current count
      const pipeline = redisClient.multi();
      pipeline.incr(key);
      pipeline.pexpire(key, this.options.windowMs);
      const results = await pipeline.exec();

      if (!results) {
        throw new Error("Redis pipeline execution failed");
      }

      const [countResult, _] = results;
      const count = countResult as number;

      const allowed = count <= this.options.limit;
      const remaining = Math.max(0, this.options.limit - count);
      const retryAfter = allowed
        ? undefined
        : Math.ceil(this.options.windowMs / 1000);

      return {
        allowed,
        limit: this.options.limit,
        remaining,
        resetTime: windowEnd,
        retryAfter,
      };
    } catch (error) {
      // On Redis failure, allow request (fail open)
      logger.error("Rate limiter Redis error", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        allowed: true,
        limit: this.options.limit,
        remaining: this.options.limit - 1,
        resetTime: windowEnd,
      };
    }
  }

  /**
   * Reset limit for identifier
   */
  async reset(identifier: string): Promise<void> {
    const key = `${this.options.keyPrefix}:${identifier}`;
    await redisClient.del(key);
  }

  /**
   * Get current count without incrementing
   */
  async getCount(identifier: string): Promise<number> {
    const key = `${this.options.keyPrefix}:${identifier}`;
    const count = await redisClient.get(key);
    return count ? parseInt(count, 10) : 0;
  }
}

/**
 * Sliding window rate limiter
 * More granular control with time-based buckets
 */
export class SlidingWindowLimiter {
  private options: RateLimitOptions;

  constructor(options: RateLimitOptions) {
    this.options = options;
  }

  /**
   * Check limit using sliding window algorithm
   * Removes old requests outside current window
   */
  async checkLimit(identifier: string): Promise<RateLimitResult> {
    const key = `${this.options.keyPrefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - this.options.windowMs;
    const windowEnd = now + Math.ceil(this.options.windowMs / 1000);

    try {
      const pipeline = redisClient.multi();

      // Remove old requests outside window
      pipeline.zremrangebyscore(key, 0, windowStart);

      // Count remaining requests in window
      pipeline.zcount(key, windowStart, now);

      // Add current request
      pipeline.zadd(key, now, `${now}-${Math.random()}`);

      // Set expiry
      pipeline.expire(key, Math.ceil(this.options.windowMs / 1000));

      const results = await pipeline.exec();

      if (!results) {
        throw new Error("Redis pipeline execution failed");
      }

      const [_, countResult, __] = results;
      const count = (countResult as number) + 1; // Include current request

      const allowed = count <= this.options.limit;
      const remaining = Math.max(0, this.options.limit - count);
      const retryAfter = allowed
        ? undefined
        : Math.ceil(this.options.windowMs / 1000);

      return {
        allowed,
        limit: this.options.limit,
        remaining,
        resetTime: Math.floor(windowEnd),
        retryAfter,
      };
    } catch (error) {
      logger.error("Sliding window limiter Redis error", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        allowed: true,
        limit: this.options.limit,
        remaining: this.options.limit - 1,
        resetTime: Math.floor(windowEnd),
      };
    }
  }

  async reset(identifier: string): Promise<void> {
    const key = `${this.options.keyPrefix}:${identifier}`;
    await redisClient.del(key);
  }
}

/**
 * Token bucket rate limiter
 * Better for burst tolerance
 */
export class TokenBucketLimiter {
  private options: RateLimitOptions;
  private refillRate: number;

  constructor(options: RateLimitOptions) {
    this.options = options;
    // Tokens per millisecond
    this.refillRate = options.limit / options.windowMs;
  }

  async checkLimit(identifier: string): Promise<RateLimitResult> {
    const key = `${this.options.keyPrefix}:${identifier}`;
    const lastRefillKey = `${key}:refill`;
    const now = Math.floor(Date.now());
    const windowEnd = now + Math.ceil(this.options.windowMs / 1000);

    try {
      const pipeline = redisClient.multi();

      // Get current tokens
      pipeline.get(key);
      pipeline.get(lastRefillKey);

      const results = await pipeline.exec();
      if (!results) throw new Error("Redis pipeline execution failed");

      const [tokensResult, lastRefillResult] = results;
      let tokens = tokensResult
        ? parseFloat(tokensResult as string)
        : this.options.limit;
      const lastRefill = lastRefillResult
        ? parseInt(lastRefillResult as string, 10)
        : now;

      // Calculate elapsed time and refilled tokens
      const elapsed = Math.max(0, now - lastRefill);
      const refilled = elapsed * this.refillRate;
      tokens = Math.min(this.options.limit, tokens + refilled);

      // Consume one token
      const allowed = tokens >= 1;
      if (allowed) {
        tokens -= 1;
      }

      // Update in Redis
      const updatePipeline = redisClient.multi();
      updatePipeline.setex(
        key,
        Math.ceil(this.options.windowMs / 1000),
        String(tokens),
      );
      updatePipeline.setex(
        lastRefillKey,
        Math.ceil(this.options.windowMs / 1000),
        String(now),
      );
      await updatePipeline.exec();

      return {
        allowed,
        limit: this.options.limit,
        remaining: Math.floor(tokens),
        resetTime: Math.floor(windowEnd),
        retryAfter: allowed ? undefined : 1,
      };
    } catch (error) {
      logger.error("Token bucket limiter Redis error", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        allowed: true,
        limit: this.options.limit,
        remaining: this.options.limit - 1,
        resetTime: Math.floor(windowEnd),
      };
    }
  }

  async reset(identifier: string): Promise<void> {
    const key = `${this.options.keyPrefix}:${identifier}`;
    const pipeline = redisClient.multi();
    pipeline.del(key);
    pipeline.del(`${key}:refill`);
    await pipeline.exec();
  }
}
```

## 2. Rate Limit Configuration (config.ts)

```typescript
import { RateLimitOptions } from "./engine";

export interface EndpointRateLimitConfig {
  limits: RateLimitOptions;
  keyGenerator?: (req: any) => string;
  shouldCount?: (req: any, res: any) => boolean;
  skipWhitelist?: boolean;
}

/**
 * Global rate limit configurations
 * Endpoint: limit (requests), window (milliseconds)
 */
export const RATE_LIMIT_CONFIG: Record<string, EndpointRateLimitConfig> = {
  // ============================================================================
  // AUTHENTICATION ENDPOINTS
  // ============================================================================
  "/api/auth/register": {
    limits: {
      keyPrefix: "rl:auth:register",
      limit: 5, // 5 registrations
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.ip,
  },

  "/api/auth/login": {
    limits: {
      keyPrefix: "rl:auth:login",
      limit: 10, // 10 attempts
      windowMs: 15 * 60 * 1000, // per 15 minutes
    },
    keyGenerator: (req) => req.ip,
    shouldCount: (req, res) => true, // Count all attempts (failures more important)
  },

  "/api/auth/2fa/enable": {
    limits: {
      keyPrefix: "rl:auth:2fa",
      limit: 3, // 3 attempts
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id || req.ip,
  },

  "/oauth/token": {
    limits: {
      keyPrefix: "rl:oauth:token",
      limit: 100, // 100 token requests
      windowMs: 60 * 1000, // per minute
    },
    keyGenerator: (req) => req.user?.id || req.ip,
  },

  // ============================================================================
  // TRANSACTION ENDPOINTS
  // ============================================================================
  "/api/transactions/deposit": {
    limits: {
      keyPrefix: "rl:tx:deposit",
      limit: 50, // 50 deposits
      windowMs: 60 * 60 * 1000, // per hour per user
    },
    keyGenerator: (req) => req.user?.id,
  },

  "/api/transactions/withdraw": {
    limits: {
      keyPrefix: "rl:tx:withdraw",
      limit: 30, // 30 withdrawals
      windowMs: 60 * 60 * 1000, // per hour per user
    },
    keyGenerator: (req) => req.user?.id,
  },

  "/api/transactions/list": {
    limits: {
      keyPrefix: "rl:tx:list",
      limit: 1000, // 1000 list requests
      windowMs: 60 * 1000, // per minute per user
    },
    keyGenerator: (req) => req.user?.id || req.ip,
  },

  "/api/transactions/:id/cancel": {
    limits: {
      keyPrefix: "rl:tx:cancel",
      limit: 10, // 10 cancellations
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id,
  },

  "/api/transactions/:id/dispute": {
    limits: {
      keyPrefix: "rl:tx:dispute",
      limit: 5, // 5 disputes
      windowMs: 24 * 60 * 60 * 1000, // per day
    },
    keyGenerator: (req) => req.user?.id,
  },

  "/api/transactions/bulk": {
    limits: {
      keyPrefix: "rl:tx:bulk",
      limit: 10, // 10 bulk operations
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id || req.ip,
  },

  // ============================================================================
  // KYC ENDPOINTS
  // ============================================================================
  "/api/kyc/submit": {
    limits: {
      keyPrefix: "rl:kyc:submit",
      limit: 3, // 3 submissions
      windowMs: 24 * 60 * 60 * 1000, // per day
    },
    keyGenerator: (req) => req.user?.id,
  },

  "/api/kyc/status": {
    limits: {
      keyPrefix: "rl:kyc:status",
      limit: 100, // 100 checks
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id || req.ip,
  },

  // ============================================================================
  // VAULT ENDPOINTS
  // ============================================================================
  "/api/vaults": {
    limits: {
      keyPrefix: "rl:vault:list",
      limit: 500, // 500 vault list requests
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id || req.ip,
  },

  "/api/vaults/:id/transfer": {
    limits: {
      keyPrefix: "rl:vault:transfer",
      limit: 100, // 100 transfers
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id,
  },

  // ============================================================================
  // DISPUTE ENDPOINTS
  // ============================================================================
  "/api/disputes": {
    limits: {
      keyPrefix: "rl:dispute:list",
      limit: 500, // 500 list requests
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id || req.ip,
  },

  "/api/disputes/:id": {
    limits: {
      keyPrefix: "rl:dispute:update",
      limit: 50, // 50 updates
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id,
  },

  // ============================================================================
  // DATA EXPORT (SENSITIVE)
  // ============================================================================
  "/api/gdpr/export": {
    limits: {
      keyPrefix: "rl:gdpr:export",
      limit: 3, // 3 exports
      windowMs: 24 * 60 * 60 * 1000, // per day
    },
    keyGenerator: (req) => req.user?.id,
  },

  "/api/gdpr/delete": {
    limits: {
      keyPrefix: "rl:gdpr:delete",
      limit: 1, // 1 deletion
      windowMs: 24 * 60 * 60 * 1000, // per day
    },
    keyGenerator: (req) => req.user?.id,
  },

  // ============================================================================
  // SEP PROTOCOL ENDPOINTS
  // ============================================================================
  "/sep10/auth": {
    limits: {
      keyPrefix: "rl:sep10:auth",
      limit: 100, // 100 challenges
      windowMs: 60 * 60 * 1000, // per hour per IP
    },
    keyGenerator: (req) => req.ip,
  },

  "/sep12/customer": {
    limits: {
      keyPrefix: "rl:sep12:customer",
      limit: 50, // 50 KYC requests
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id || req.ip,
  },

  "/sep24/transactions/deposit/interactive": {
    limits: {
      keyPrefix: "rl:sep24:deposit",
      limit: 20, // 20 interactive deposits
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id || req.ip,
  },

  "/sep31/transactions": {
    limits: {
      keyPrefix: "rl:sep31:send",
      limit: 10, // 10 send payments
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id || req.ip,
  },

  // ============================================================================
  // ADMIN ENDPOINTS
  // ============================================================================
  "/api/admin": {
    limits: {
      keyPrefix: "rl:admin:general",
      limit: 100, // 100 requests
      windowMs: 60 * 1000, // per minute
    },
    keyGenerator: (req) => req.user?.id,
    skipWhitelist: false,
  },

  "/api/admin/reconciliation": {
    limits: {
      keyPrefix: "rl:admin:reconciliation",
      limit: 10, // 10 reconciliation runs
      windowMs: 60 * 60 * 1000, // per hour
    },
    keyGenerator: (req) => req.user?.id,
  },
};

/**
 * Get configuration for an endpoint
 */
export function getEndpointConfig(
  endpoint: string,
): EndpointRateLimitConfig | undefined {
  // Exact match
  if (RATE_LIMIT_CONFIG[endpoint]) {
    return RATE_LIMIT_CONFIG[endpoint];
  }

  // Pattern matching for parameterized routes
  const patterns = Object.keys(RATE_LIMIT_CONFIG);
  for (const pattern of patterns) {
    if (matchPattern(pattern, endpoint)) {
      return RATE_LIMIT_CONFIG[pattern];
    }
  }

  return undefined;
}

/**
 * Simple pattern matcher for routes with parameters
 */
function matchPattern(pattern: string, endpoint: string): boolean {
  const patternParts = pattern.split("/");
  const endpointParts = endpoint.split("/");

  if (patternParts.length !== endpointParts.length) {
    return false;
  }

  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    if (patternPart.startsWith(":")) {
      // Parameter, matches anything
      continue;
    }
    if (patternPart !== endpointParts[i]) {
      return false;
    }
  }

  return true;
}
```

## 3. IP Whitelist (whitelist.ts)

```typescript
import { redisClient } from "../../config/redis";
import { logger } from "../../services/logger";

export class RateLimitWhitelist {
  private static readonly WHITELIST_KEY = "rl:whitelist:ips";
  private static readonly CACHE_TTL = 5 * 60; // 5 minutes

  /**
   * Check if IP is whitelisted (skip rate limiting)
   */
  static async isWhitelisted(ip: string): Promise<boolean> {
    try {
      const members = await redisClient.smembers(this.WHITELIST_KEY);
      if (members.includes(ip)) {
        return true;
      }

      // Check against CIDR ranges
      for (const member of members) {
        if (this.isCIDRMatch(ip, member)) {
          return true;
        }
      }

      return false;
    } catch (error) {
      logger.error("Whitelist lookup error", {
        ip,
        error: error instanceof Error ? error.message : String(error),
      });
      // Fail open on error
      return false;
    }
  }

  /**
   * Add IP to whitelist
   */
  static async whitelist(ip: string): Promise<void> {
    await redisClient.sadd(this.WHITELIST_KEY, ip);
  }

  /**
   * Remove IP from whitelist
   */
  static async removeWhitelist(ip: string): Promise<void> {
    await redisClient.srem(this.WHITELIST_KEY, ip);
  }

  /**
   * Get all whitelisted IPs
   */
  static async getWhitelist(): Promise<string[]> {
    return redisClient.smembers(this.WHITELIST_KEY);
  }

  /**
   * CIDR range matching
   */
  private static isCIDRMatch(ip: string, cidr: string): boolean {
    if (!cidr.includes("/")) {
      return false;
    }

    try {
      const [range, bits] = cidr.split("/");
      const rangeNum = this.ipToNumber(range);
      const ipNum = this.ipToNumber(ip);
      const maskBits = parseInt(bits, 10);
      const mask = (0xffffffff << (32 - maskBits)) >>> 0;

      return (rangeNum & mask) === (ipNum & mask);
    } catch {
      return false;
    }
  }

  /**
   * Convert IP to number
   */
  private static ipToNumber(ip: string): number {
    const parts = ip.split(".");
    return (
      (parseInt(parts[0], 10) << 24) +
      (parseInt(parts[1], 10) << 16) +
      (parseInt(parts[2], 10) << 8) +
      parseInt(parts[3], 10)
    );
  }
}

/**
 * Default whitelisted IPs/ranges
 * Set via environment variable: RATE_LIMIT_WHITELIST_IPS=127.0.0.1,10.0.0.0/8
 */
export async function initializeWhitelist(): Promise<void> {
  const whitelist = (process.env.RATE_LIMIT_WHITELIST_IPS || "")
    .split(",")
    .filter(Boolean);

  for (const ip of whitelist) {
    await RateLimitWhitelist.whitelist(ip.trim());
  }

  if (whitelist.length > 0) {
    logger.info("Rate limit whitelist initialized", {
      count: whitelist.length,
    });
  }
}
```

## 4. Middleware Exports (index.ts)

```typescript
import { Request, Response, NextFunction } from "express";
import { RateLimiter, RateLimitResult } from "./engine";
import { getEndpointConfig } from "./config";
import { RateLimitWhitelist } from "./whitelist";
import { logRateLimitViolation } from "./logger";

/**
 * Create rate limiting middleware for an endpoint
 */
export function createRateLimitMiddleware(endpoint: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check whitelist
      if (await RateLimitWhitelist.isWhitelisted(req.ip)) {
        return next();
      }

      const config = getEndpointConfig(endpoint);
      if (!config) {
        // No config = no limit
        return next();
      }

      const limiter = new RateLimiter(config.limits);
      const identifier = config.keyGenerator?.(req) || req.ip;

      if (!identifier) {
        return next();
      }

      const result = await limiter.checkLimit(identifier);

      // Set response headers
      res.set({
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(result.resetTime),
      });

      if (!result.allowed) {
        res.set("Retry-After", String(result.retryAfter || 60));

        await logRateLimitViolation(req, endpoint, result, identifier);

        return res.status(429).json({
          success: false,
          error: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests, please try again later",
          retryAfter: result.retryAfter,
          resetTime: new Date(result.resetTime * 1000).toISOString(),
        });
      }

      next();
    } catch (error) {
      // On error, allow request (fail open)
      console.error("Rate limit check error", error);
      next();
    }
  };
}

export * from "./engine";
export * from "./config";
export * from "./whitelist";
export * from "./logger";
```

## 5. Integration with Routes

```typescript
// src/routes/transactions.ts
import express from "express";
import { createRateLimitMiddleware } from "../middleware/rateLimiters";
import { validateBody } from "../middleware/validators";

export const transactionRoutes = express.Router();

transactionRoutes.post(
  "/deposit",
  createRateLimitMiddleware("/api/transactions/deposit"),
  validateBody(depositSchema),
  transactionController.deposit,
);

transactionRoutes.post(
  "/withdraw",
  createRateLimitMiddleware("/api/transactions/withdraw"),
  validateBody(withdrawSchema),
  transactionController.withdraw,
);
```

## Monitoring & Metrics

```typescript
// src/middleware/rateLimiters/metrics.ts
import { Counter, Histogram } from "prom-client";

export const rateLimitMetrics = {
  checks: new Counter({
    name: "rate_limit_checks_total",
    help: "Total rate limit checks",
    labelNames: ["endpoint", "action"],
  }),

  violations: new Counter({
    name: "rate_limit_violations_total",
    help: "Total rate limit violations",
    labelNames: ["endpoint", "identifier_type"],
  }),

  duration: new Histogram({
    name: "rate_limit_check_duration_ms",
    help: "Rate limit check duration",
    labelNames: ["endpoint"],
    buckets: [1, 5, 10, 25, 50],
  }),

  topOffenders: new Counter({
    name: "rate_limit_top_offenders",
    help: "Requests from offending IPs",
    labelNames: ["ip", "endpoint"],
  }),
};
```
