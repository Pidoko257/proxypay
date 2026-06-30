/**
 * APQ Redis Cache Adapter
 *
 * Implements the KeyValueCache interface expected by Apollo Server's
 * persistedQueries option. Stores query hash → query string mappings
 * in Redis with a configurable TTL.
 *
 * Failure policy: if Redis is unavailable, every operation is a no-op
 * so Apollo falls back to accepting full query strings — the server
 * never crashes due to cache downtime.
 */

import IORedis from "ioredis";
import { sharedIORedisPublisher } from "../config/redis";

export interface KeyValueCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<boolean | void>;
}

const APQ_KEY_PREFIX = "apq:";
const DEFAULT_TTL_SECONDS = parseInt(process.env.APQ_TTL_SECONDS || "86400", 10); // 24 h

export class RedisAPQCache implements KeyValueCache {
  private client: IORedis;
  private ttl: number;
  private available = true;

  constructor(client: IORedis, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.client = client;
    this.ttl = ttlSeconds;

    // Track Redis availability so we can degrade gracefully
    this.client.on("error", () => {
      if (this.available) {
        console.warn("[APQ] Redis unavailable — falling back to full queries");
        this.available = false;
      }
    });

    this.client.on("ready", () => {
      if (!this.available) {
        console.log("[APQ] Redis reconnected — persisted queries re-enabled");
        this.available = true;
      }
    });
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.available) return undefined;
    try {
      const value = await this.client.get(`${APQ_KEY_PREFIX}${key}`);
      return value ?? undefined;
    } catch (err) {
      console.warn("[APQ] Redis get failed", { key, err });
      return undefined;
    }
  }

  async set(key: string, value: string, options?: { ttl?: number }): Promise<void> {
    if (!this.available) return;
    const ttl = options?.ttl ?? this.ttl;
    try {
      await this.client.set(`${APQ_KEY_PREFIX}${key}`, value, "EX", ttl);
    } catch (err) {
      console.warn("[APQ] Redis set failed", { key, err });
    }
  }

  async delete(key: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      const deleted = await this.client.del(`${APQ_KEY_PREFIX}${key}`);
      return deleted > 0;
    } catch (err) {
      console.warn("[APQ] Redis delete failed", { key, err });
      return false;
    }
  }
}

/**
 * Creates a RedisAPQCache backed by the shared ioredis publisher connection.
 */
export function createAPQCache(): RedisAPQCache {
  const ttl = parseInt(process.env.APQ_TTL_SECONDS || "86400", 10);
  return new RedisAPQCache(sharedIORedisPublisher, ttl);
}
