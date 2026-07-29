import Redlock, { Lock, Settings } from "redlock";
import { redisClient } from "../config/redis";
import {
  lockAcquisitionTotal,
  lockContentionTotal,
  lockAcquisitionDurationSeconds,
} from "./metrics";

export class LockAcquisitionTimeoutError extends Error {
  constructor(public readonly resource: string, public readonly timeoutMs: number) {
    super(`Lock acquisition timed out after ${timeoutMs}ms for resource: ${resource}`);
    this.name = "LockAcquisitionTimeoutError";
  }
}

export interface AcquireOptions {
  ttl?: number; // lock TTL in ms
  timeoutMs?: number; // max timeout in ms to acquire the lock
  retryCount?: number; // custom number of retries
  retryDelay?: number; // base delay in ms between retries
  backoffFactor?: number; // exponential backoff multiplier
}

/**
 * Distributed lock manager using Redlock algorithm.
 * Prevents race conditions in distributed systems with timeout and contention tracking.
 */
class LockManager {
  private redlock: Redlock;
  private readonly defaultTTL = 10000; // 10 seconds default TTL
  private readonly defaultTimeoutMs = 5000; // 5 seconds default timeout

  constructor() {
    const settings: Partial<Settings> = {
      driftFactor: 0.01,
      retryCount: 5,
      retryDelay: 150,
      retryJitter: 100,
      automaticExtensionThreshold: 500,
    };

    // Type assertion needed for Redlock compatibility with ioredis
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.redlock = new Redlock([redisClient as any], settings);

    this.redlock.on("error", (error) => {
      console.error("Redlock error:", error);
    });
  }

  private getResourceType(resource: string): string {
    return resource.split(":")[0] || "generic";
  }

  /**
   * Acquires a distributed lock for a given resource with configurable timeout and backoff strategy.
   *
   * @param resource - Unique identifier for the resource to lock
   * @param options - TTL in ms OR AcquireOptions configuration object
   * @returns Lock object if successful
   * @throws LockAcquisitionTimeoutError if lock acquisition times out
   */
  async acquire(
    resource: string,
    options: number | AcquireOptions = this.defaultTTL,
  ): Promise<Lock> {
    const opts: AcquireOptions =
      typeof options === "number" ? { ttl: options } : options;
    const ttl = opts.ttl ?? this.defaultTTL;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const retryCount = opts.retryCount ?? 5;
    const baseRetryDelay = opts.retryDelay ?? 150;
    const backoffFactor = opts.backoffFactor ?? 1.5;

    const resourceType = this.getResourceType(resource);
    const startTime = Date.now();

    // Custom Redlock instance if custom retry parameters specified
    const redlockInstance =
      opts.retryCount !== undefined || opts.retryDelay !== undefined
        ? new Redlock([redisClient as any], {
            driftFactor: 0.01,
            retryCount: retryCount,
            retryDelay: baseRetryDelay,
            retryJitter: Math.floor(baseRetryDelay * 0.5),
          })
        : this.redlock;

    const acquirePromise = (async () => {
      let attempts = 0;
      let delay = baseRetryDelay;

      while (attempts <= retryCount) {
        try {
          const lock = await redlockInstance.acquire([`locks:${resource}`], ttl);
          const duration = (Date.now() - startTime) / 1000;
          lockAcquisitionDurationSeconds.observe({ resource_type: resourceType }, duration);
          lockAcquisitionTotal.inc({ resource_type: resourceType, status: "success" });
          console.log(`Lock acquired: ${resource} (TTL: ${ttl}ms, took ${Math.round(duration * 1000)}ms)`);
          return lock;
        } catch (err) {
          attempts++;
          lockContentionTotal.inc({ resource_type: resourceType });

          if (attempts > retryCount) {
            throw err;
          }

          // Apply exponential backoff with jitter
          const jitter = Math.floor(Math.random() * delay * 0.2);
          const backoffDelay = Math.floor(delay * Math.pow(backoffFactor, attempts - 1)) + jitter;
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }
      }
      throw new Error(`Failed to acquire lock after ${retryCount} retries`);
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        lockContentionTotal.inc({ resource_type: resourceType });
        lockAcquisitionTotal.inc({ resource_type: resourceType, status: "timeout" });
        reject(new LockAcquisitionTimeoutError(resource, timeoutMs));
      }, timeoutMs);

      // Unref node timer if supported to allow process exit
      if (typeof timer === "object" && "unref" in timer) {
        (timer as any).unref();
      }
    });

    try {
      return await Promise.race([acquirePromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof LockAcquisitionTimeoutError) {
        console.error(`Lock timeout: ${resource} timed out after ${timeoutMs}ms`);
      } else {
        lockAcquisitionTotal.inc({ resource_type: resourceType, status: "failure" });
        console.error(`Failed to acquire lock: ${resource}`, error);
      }
      throw error;
    }
  }

  /**
   * Releases a previously acquired lock.
   */
  async release(lock: Lock): Promise<void> {
    try {
      await lock.release();
      console.log(`Lock released: ${lock.resources}`);
    } catch (error) {
      console.error("Failed to release lock:", error);
      throw error;
    }
  }

  /**
   * Extends the TTL of an existing lock.
   */
  async extend(lock: Lock, ttl: number): Promise<Lock> {
    try {
      const extendedLock = await lock.extend(ttl);
      console.log(`Lock extended: ${lock.resources} (+${ttl}ms)`);
      return extendedLock;
    } catch (error) {
      console.error("Failed to extend lock:", error);
      throw error;
    }
  }

  /**
   * Executes a function with automatic lock acquisition and release, incorporating configurable timeout.
   */
  async withLock<T>(
    resource: string,
    fn: () => Promise<T>,
    options?: number | AcquireOptions,
  ): Promise<T> {
    const lock = await this.acquire(resource, options);
    try {
      return await fn();
    } finally {
      await this.release(lock);
    }
  }

  /**
   * Attempts to acquire a lock without retrying.
   * Returns null if lock cannot be acquired immediately.
   */
  async tryAcquire(
    resource: string,
    ttl: number = this.defaultTTL,
  ): Promise<Lock | null> {
    const resourceType = this.getResourceType(resource);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const noRetryRedlock = new Redlock([redisClient as any], {
        retryCount: 0,
      });
      const lock = await noRetryRedlock.acquire([`locks:${resource}`], ttl);
      lockAcquisitionTotal.inc({ resource_type: resourceType, status: "success" });
      console.log(`Lock acquired (no retry): ${resource}`);
      return lock;
    } catch (err) {
      lockContentionTotal.inc({ resource_type: resourceType });
      lockAcquisitionTotal.inc({ resource_type: resourceType, status: "busy" });
      console.log(`Lock not available: ${resource}`, err);
      return null;
    }
  }
}

// Singleton instance
export const lockManager = new LockManager();

/**
 * Lock key generators for common use cases
 */
export const LockKeys = {
  transaction: (id: string) => `transaction:${id}`,
  phoneNumber: (phone: string) => `phone:${phone}`,
  idempotency: (key: string) => `idempotency:${key}`,
  referenceNumber: (date: string) => `reference:${date}`,
  stellarAccount: (address: string) => `stellar:${address}`,
  provider: (provider: string, phone: string) =>
    `provider:${provider}:${phone}`,
  vault: (vaultId: string) => `vault:${vaultId}`,
  userVaults: (userId: string) => `user-vaults:${userId}`,
  vaultTransfer: (userId: string, vaultId: string) => `vault-transfer:${userId}:${vaultId}`,
};
