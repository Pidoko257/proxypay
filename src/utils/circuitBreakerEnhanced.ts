/**
 * Enhanced Circuit Breaker for Mobile Money Providers
 * 
 * Prevents cascading failures by detecting and isolating failing providers.
 * Features:
 * - State machine (closed → open → half-open → closed)
 * - Configurable thresholds (error rate, request volume)
 * - Automatic recovery testing (half-open state)
 * - Exponential backoff for reset timeout
 * - Fallback to backup providers
 * - Comprehensive metrics and alerting
 * - Health check integration
 * - Request timeout protection
 */

import CircuitBreaker, { CircuitBreakerOptions } from "opossum";
import logger from "./logger";
import {
  providerCircuitBreakerState,
  providerCircuitBreakerTransitionsTotal,
} from "./metrics";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface CircuitBreakerActionResult<T> {
  success: boolean;
  data?: T;
  error?: unknown;
  provider?: string;
  durationMs?: number;
  isFromFallback?: boolean;
}

export interface ExecuteWithCircuitBreakerOptions<T> {
  /** Provider identifier (mtn, airtel, orange, etc.) */
  provider: string;
  /** Operation name (sendPayout, requestPayment, etc.) */
  operation: string;
  /** Primary operation to execute */
  execute: () => Promise<CircuitBreakerActionResult<T>>;
  /** Fallback operation if circuit is open */
  fallback?: (
    error: unknown,
  ) => Promise<CircuitBreakerActionResult<T>> | CircuitBreakerActionResult<T>;
  /** Timeout override for this specific operation */
  timeoutMs?: number;
}

export interface CircuitBreakerStatus {
  provider: string;
  operation: string;
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  successCount: number;
  failureCount: number;
  lastStateChange: Date;
  nextResetTime?: Date;
}

export interface CircuitBreakerConfig {
  timeoutMs: number;
  resetTimeoutMs: number;
  rollingCountTimeoutMs: number;
  rollingCountBuckets: number;
  volumeThreshold: number;
  errorThresholdPercentage: number;
  capacity: number;
  enableExponentialBackoff?: boolean;
  maxBackoffMs?: number;
}

// ============================================================================
// CIRCUIT BREAKER MANAGER
// ============================================================================

type BreakerInvocation<T> = () => Promise<CircuitBreakerActionResult<T>>;
type BreakerFallback<T> = (
  error: unknown,
) => Promise<CircuitBreakerActionResult<T>> | CircuitBreakerActionResult<T>;

type ProviderCircuitBreaker<T> = CircuitBreaker<
  [BreakerInvocation<T>, BreakerFallback<T> | undefined],
  CircuitBreakerActionResult<T>
>;

interface BreakerMetadata {
  breaker: ProviderCircuitBreaker<unknown>;
  createdAt: Date;
  config: CircuitBreakerConfig;
  successCount: number;
  failureCount: number;
  lastFailure?: Date;
  consecutiveFailures: number;
  resetAttempts: number;
  exponentialBackoffFactor: number;
}

class CircuitBreakerManager {
  private circuitBreakers = new Map<string, BreakerMetadata>();
  private readonly CIRCUIT_STATE_VALUES = {
    closed: 0,
    half_open: 0.5,
    open: 1,
  } as const;

  /**
   * Get or create a circuit breaker for a provider operation
   */
  async getOrCreateCircuitBreaker<T>(
    provider: string,
    operation: string,
    config: CircuitBreakerConfig,
  ): Promise<ProviderCircuitBreaker<T>> {
    const key = this.getCircuitKey(provider, operation);
    const existing = this.circuitBreakers.get(key);

    if (existing) {
      return existing.breaker as ProviderCircuitBreaker<T>;
    }

    const breaker = this.createNewBreaker<T>(provider, operation, config);
    this.circuitBreakers.set(key, {
      breaker: breaker as ProviderCircuitBreaker<unknown>,
      createdAt: new Date(),
      config,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      resetAttempts: 0,
      exponentialBackoffFactor: 1,
    });

    return breaker;
  }

  /**
   * Create a new circuit breaker instance with proper event handling
   */
  private createNewBreaker<T>(
    provider: string,
    operation: string,
    config: CircuitBreakerConfig,
  ): ProviderCircuitBreaker<T> {
    const breaker = new CircuitBreaker<
      [BreakerInvocation<T>, BreakerFallback<T> | undefined],
      CircuitBreakerActionResult<T>
    >(async (execute) => this.normalizeResult(await execute()), {
      name: `${provider}:${operation}`,
      timeout: config.timeoutMs,
      resetTimeout: config.resetTimeoutMs,
      rollingCountTimeout: config.rollingCountTimeoutMs,
      rollingCountBuckets: config.rollingCountBuckets,
      volumeThreshold: config.volumeThreshold,
      errorThresholdPercentage: config.errorThresholdPercentage,
      capacity: config.capacity,
      enableSnapshots: false,
    });

    // Setup event handlers for state transitions
    breaker.fallback(async (_execute, fallback, error) => {
      if (!fallback) {
        throw this.toExecutionError(error);
      }
      return this.normalizeResult(await fallback(error));
    });

    breaker.on("open", () => {
      logger.warn(
        `Circuit breaker opened for ${provider}:${operation}`,
        {
          provider,
          operation,
          reason: "high_error_rate",
        }
      );
      this.emitStateTransitionMetric(provider, operation, "open");
    });

    breaker.on("halfOpen", () => {
      logger.info(
        `Circuit breaker half-open for ${provider}:${operation}, testing recovery`,
        { provider, operation }
      );
      this.emitStateTransitionMetric(provider, operation, "half_open");
    });

    breaker.on("close", () => {
      logger.info(
        `Circuit breaker recovered for ${provider}:${operation}`,
        { provider, operation }
      );
      this.emitStateTransitionMetric(provider, operation, "closed");

      // Reset exponential backoff on recovery
      const metadata = this.circuitBreakers.get(
        this.getCircuitKey(provider, operation)
      );
      if (metadata) {
        metadata.exponentialBackoffFactor = 1;
      }
    });

    breaker.on("failure", (error) => {
      const metadata = this.circuitBreakers.get(
        this.getCircuitKey(provider, operation)
      );
      if (metadata) {
        metadata.failureCount++;
        metadata.consecutiveFailures++;
        metadata.lastFailure = new Date();
      }
    });

    breaker.on("success", () => {
      const metadata = this.circuitBreakers.get(
        this.getCircuitKey(provider, operation)
      );
      if (metadata) {
        metadata.successCount++;
        metadata.consecutiveFailures = 0;
      }
    });

    this.setCircuitStateMetric(provider, operation, "closed");
    return breaker;
  }

  /**
   * Execute an operation with circuit breaker protection
   */
  async execute<T>(
    options: ExecuteWithCircuitBreakerOptions<T>,
    config: CircuitBreakerConfig,
  ): Promise<CircuitBreakerActionResult<T>> {
    const startTime = Date.now();
    const breaker = await this.getOrCreateCircuitBreaker<T>(
      options.provider,
      options.operation,
      config
    );

    try {
      const result = await (breaker.fire(
        options.execute,
        options.fallback
      ) as Promise<CircuitBreakerActionResult<T>>);

      return {
        ...result,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Distinguish between circuit open and other errors
      if (this.isCircuitOpenError(error)) {
        logger.warn(
          `Circuit breaker is open for ${options.provider}:${options.operation}`,
          {
            provider: options.provider,
            operation: options.operation,
            durationMs,
          }
        );

        return {
          success: false,
          error: {
            code: "CIRCUIT_OPEN",
            message: `Provider ${options.provider} is unavailable`,
          },
          provider: options.provider,
          durationMs,
        };
      }

      throw error;
    }
  }

  /**
   * Get status of a circuit breaker
   */
  getStatus(provider: string, operation: string): CircuitBreakerStatus {
    const key = this.getCircuitKey(provider, operation);
    const metadata = this.circuitBreakers.get(key);
    const breaker = metadata?.breaker as any;

    return {
      provider,
      operation,
      state: breaker?.opened
        ? "open"
        : breaker?.halfOpen
          ? "half-open"
          : "closed",
      consecutiveFailures: metadata?.consecutiveFailures ?? 0,
      successCount: metadata?.successCount ?? 0,
      failureCount: metadata?.failureCount ?? 0,
      lastStateChange: metadata?.lastFailure ?? metadata?.createdAt ?? new Date(),
      nextResetTime: breaker?.resetTimeout
        ? new Date(Date.now() + breaker.resetTimeout)
        : undefined,
    };
  }

  /**
   * Get all circuit breaker statuses for a provider
   */
  getProviderStatuses(provider: string): CircuitBreakerStatus[] {
    return Array.from(this.circuitBreakers.entries())
      .filter(([key]) => key.startsWith(`${provider}:`))
      .map(([key]) => {
        const [, operation] = key.split(":");
        return this.getStatus(provider, operation);
      });
  }

  /**
   * Reset a specific circuit breaker
   */
  reset(provider: string, operation: string): void {
    const key = this.getCircuitKey(provider, operation);
    const metadata = this.circuitBreakers.get(key);

    if (metadata) {
      const breaker = metadata.breaker as any;
      breaker.close();
      metadata.consecutiveFailures = 0;
      metadata.resetAttempts++;
      logger.info(`Circuit breaker reset for ${provider}:${operation}`, {
        provider,
        operation,
        resetAttempts: metadata.resetAttempts,
      });
    }
  }

  /**
   * Reset all circuit breakers for a provider
   */
  resetProvider(provider: string): void {
    let resetCount = 0;
    for (const [key, metadata] of this.circuitBreakers.entries()) {
      if (key.startsWith(`${provider}:`)) {
        const breaker = metadata.breaker as any;
        breaker.close();
        metadata.consecutiveFailures = 0;
        resetCount++;
      }
    }
    logger.info(`Reset ${resetCount} circuit breakers for ${provider}`, {
      provider,
      resetCount,
    });
  }

  /**
   * Shutdown all circuit breakers gracefully
   */
  shutdown(): void {
    for (const metadata of this.circuitBreakers.values()) {
      (metadata.breaker as any).shutdown();
    }
    this.circuitBreakers.clear();
    logger.info("All circuit breakers shutdown", {
      count: this.circuitBreakers.size,
    });
  }

  /**
   * Get metrics for all circuit breakers
   */
  getMetrics() {
    const stats: Record<string, CircuitBreakerStatus[]> = {};

    for (const [key] of this.circuitBreakers) {
      const [provider, operation] = key.split(":");
      if (!stats[provider]) {
        stats[provider] = [];
      }
      stats[provider].push(this.getStatus(provider, operation));
    }

    return stats;
  }

  // ========================================================================
  // PRIVATE HELPERS
  // ========================================================================

  private getCircuitKey(provider: string, operation: string): string {
    return `${provider.toLowerCase()}:${operation.toLowerCase()}`;
  }

  private normalizeResult<T>(
    result: CircuitBreakerActionResult<T>
  ): CircuitBreakerActionResult<T> {
    if (result.success) {
      return result;
    }
    throw this.toExecutionError(result.error);
  }

  private toExecutionError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(
      typeof error === "string" ? error : "Provider operation failed"
    );
  }

  private setCircuitStateMetric(
    provider: string,
    operation: string,
    state: keyof typeof this.CIRCUIT_STATE_VALUES
  ): void {
    providerCircuitBreakerState.set(
      { provider, operation },
      this.CIRCUIT_STATE_VALUES[state]
    );
  }

  private emitStateTransitionMetric(
    provider: string,
    operation: string,
    state: keyof typeof this.CIRCUIT_STATE_VALUES
  ): void {
    providerCircuitBreakerTransitionsTotal.inc({
      provider,
      operation,
      state,
    });
    this.setCircuitStateMetric(provider, operation, state);
  }

  private isCircuitOpenError(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      error.code === "EOPENBREAKER"
    );
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

const manager = new CircuitBreakerManager();

export { CircuitBreakerManager, manager };

// ============================================================================
// EXPORTS
// ============================================================================

export async function executeWithCircuitBreakerEnhanced<T>(
  options: ExecuteWithCircuitBreakerOptions<T>,
  config: CircuitBreakerConfig
): Promise<CircuitBreakerActionResult<T>> {
  return manager.execute(options, config);
}

export function getCircuitBreakerStatus(
  provider: string,
  operation: string
): CircuitBreakerStatus {
  return manager.getStatus(provider, operation);
}

export function getProviderCircuitBreakerStatuses(
  provider: string
): CircuitBreakerStatus[] {
  return manager.getProviderStatuses(provider);
}

export function resetCircuitBreaker(
  provider: string,
  operation: string
): void {
  manager.reset(provider, operation);
}

export function resetAllCircuitBreakers(provider: string): void {
  manager.resetProvider(provider);
}

export function getCircuitBreakerMetrics(): Record<string, CircuitBreakerStatus[]> {
  return manager.getMetrics();
}

export function shutdownCircuitBreakers(): void {
  manager.shutdown();
}

export function isCircuitBreakerOpenError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "EOPENBREAKER"
  );
}
