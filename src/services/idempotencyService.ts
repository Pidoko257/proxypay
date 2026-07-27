import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { structuredLogger } from '../utils/structuredLogger';

export interface IdempotencyKey {
  key: string;
  requestId: string;
  response?: Record<string, any>;
  statusCode?: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface IdempotencyOptions {
  ttlSeconds?: number;
  enabled?: boolean;
}

const DEFAULT_TTL_SECONDS = 86400; // 24 hours

export class IdempotencyService {
  private redis: Redis;
  private readonly prefix = 'idempotency:';
  private readonly ttlSeconds: number;

  constructor(redis: Redis, options: IdempotencyOptions = {}) {
    this.redis = redis;
    this.ttlSeconds = options.ttlSeconds || DEFAULT_TTL_SECONDS;
  }

  /**
   * Store an idempotency key with response
   */
  async storeIdempotencyKey(
    key: string,
    requestId: string,
    response: Record<string, any>,
    statusCode: number
  ): Promise<void> {
    const idempotencyData: IdempotencyKey = {
      key,
      requestId,
      response,
      statusCode,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
    };

    const cacheKey = `${this.prefix}${key}`;
    await this.redis.setex(
      cacheKey,
      this.ttlSeconds,
      JSON.stringify(idempotencyData)
    );

    structuredLogger.debug(
      { idempotencyKey: key, ttl: this.ttlSeconds },
      'Idempotency key stored'
    );
  }

  /**
   * Retrieve cached response for idempotency key
   */
  async getIdempotencyKey(key: string): Promise<IdempotencyKey | null> {
    const cacheKey = `${this.prefix}${key}`;
    const data = await this.redis.get(cacheKey);

    if (!data) {
      return null;
    }

    try {
      const idempotencyData = JSON.parse(data) as IdempotencyKey;
      idempotencyData.createdAt = new Date(idempotencyData.createdAt);
      idempotencyData.expiresAt = new Date(idempotencyData.expiresAt);
      return idempotencyData;
    } catch (error) {
      structuredLogger.warn(
        { idempotencyKey: key, error: String(error) },
        'Failed to parse idempotency key data'
      );
      return null;
    }
  }

  /**
   * Delete an idempotency key
   */
  async deleteIdempotencyKey(key: string): Promise<void> {
    const cacheKey = `${this.prefix}${key}`;
    await this.redis.del(cacheKey);
    structuredLogger.debug({ idempotencyKey: key }, 'Idempotency key deleted');
  }

  /**
   * Check if idempotency key exists
   */
  async hasIdempotencyKey(key: string): Promise<boolean> {
    const cacheKey = `${this.prefix}${key}`;
    const exists = await this.redis.exists(cacheKey);
    return exists === 1;
  }

  /**
   * Generate a new idempotency key
   */
  generateKey(userId: string, operation: string): string {
    return `${userId}:${operation}:${uuidv4()}`;
  }

  /**
   * Get TTL of an idempotency key (in seconds)
   */
  async getTTL(key: string): Promise<number> {
    const cacheKey = `${this.prefix}${key}`;
    const ttl = await this.redis.ttl(cacheKey);
    return ttl > 0 ? ttl : 0;
  }

  /**
   * Extend TTL of an idempotency key
   */
  async extendTTL(key: string, additionalSeconds?: number): Promise<void> {
    const cacheKey = `${this.prefix}${key}`;
    const newTTL = additionalSeconds || this.ttlSeconds;
    await this.redis.expire(cacheKey, newTTL);
    structuredLogger.debug(
      { idempotencyKey: key, newTTL },
      'Idempotency key TTL extended'
    );
  }

  /**
   * Cleanup expired keys (maintenance operation)
   */
  async cleanup(): Promise<number> {
    // Redis handles expiration automatically, this is a no-op
    // but kept for interface consistency
    structuredLogger.debug('Idempotency cleanup triggered');
    return 0;
  }

  /**
   * Get all keys (for debugging/admin)
   */
  async getAllKeys(limit: number = 100): Promise<IdempotencyKey[]> {
    const keys = await this.redis.keys(`${this.prefix}*`);
    const limitedKeys = keys.slice(0, limit);
    const results: IdempotencyKey[] = [];

    for (const key of limitedKeys) {
      const data = await this.redis.get(key);
      if (data) {
        try {
          results.push(JSON.parse(data));
        } catch (error) {
          structuredLogger.warn({ key, error: String(error) }, 'Parse error');
        }
      }
    }

    return results;
  }

  /**
   * Get stats on idempotency cache
   */
  async getStats(): Promise<{
    totalKeys: number;
    averageTTL: number;
    oldestKey: Date | null;
  }> {
    const keys = await this.redis.keys(`${this.prefix}*`);
    let totalTTL = 0;
    let oldestCreatedAt: Date | null = null;

    for (const key of keys) {
      const ttl = await this.redis.ttl(key);
      if (ttl > 0) {
        totalTTL += ttl;
      }
    }

    const averageTTL = keys.length > 0 ? Math.round(totalTTL / keys.length) : 0;

    return {
      totalKeys: keys.length,
      averageTTL,
      oldestKey: oldestCreatedAt,
    };
  }
}

// Singleton instance
let idempotencyServiceInstance: IdempotencyService | null = null;

export function initializeIdempotencyService(
  redis: Redis,
  options?: IdempotencyOptions
): IdempotencyService {
  if (idempotencyServiceInstance) {
    return idempotencyServiceInstance;
  }

  idempotencyServiceInstance = new IdempotencyService(redis, options);
  return idempotencyServiceInstance;
}

export function getIdempotencyService(): IdempotencyService {
  if (!idempotencyServiceInstance) {
    throw new Error('IdempotencyService not initialized. Call initializeIdempotencyService first.');
  }
  return idempotencyServiceInstance;
}
