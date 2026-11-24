/**
 * Component Health Service
 *
 * Provides detailed diagnostics with response times for all critical components:
 * - Database (PostgreSQL)
 * - Redis Cache
 * - Mobile Money Providers (MTN, Airtel, Orange)
 * - Replication status
 * - Memory usage
 */

import { ComponentHealthMetrics, ComponentStatus } from "../types/api";
import { checkMobileMoneyHealth } from "./mobilemoney/providers/healthCheck";
import { ProviderName } from "./mobilemoney/providers/healthCheck";
import { pool } from "../config/database";
import { redisClient } from "../config/redis";

export interface ComponentHealthCheckResult {
  database: ComponentHealthMetrics;
  redis: ComponentHealthMetrics;
  providers: ComponentHealthMetrics & {
    providers?: Record<string, "up" | "down" | "unknown">;
    healthyCount?: number;
    totalCount?: number;
  };
  replication?: ComponentHealthMetrics & {
    drMode?: string;
  };
  memory?: ComponentHealthMetrics;
}

/**
 * Measure time and status of a health check operation
 */
async function measureHealthCheck<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<{ result: T; metrics: ComponentHealthMetrics }> {
  const startTime = Date.now();
  let status: ComponentStatus = "healthy";
  let error: string | undefined;

  try {
    const result = await operation();
    return {
      result,
      metrics: {
        status,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString(),
      },
    };
  } catch (err) {
    error = err instanceof Error ? err.message : "Unknown error";
    status = "down";
    return {
      result: undefined as any,
      metrics: {
        status,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString(),
        error,
      },
    };
  }
}

/**
 * Check database connectivity and response time
 */
export async function checkDatabaseHealth(): Promise<ComponentHealthMetrics> {
  const { metrics } = await measureHealthCheck(async () => {
    await pool.query("SELECT 1");
  }, "database");
  return metrics;
}

/**
 * Check Redis connectivity and response time
 */
export async function checkRedisHealth(): Promise<ComponentHealthMetrics> {
  const { metrics } = await measureHealthCheck(async () => {
    if (!redisClient?.isOpen) {
      throw new Error("Redis client not open");
    }
    await redisClient.ping();
  }, "redis");
  return metrics;
}

/**
 * Check provider health with timing
 */
export async function checkProvidersHealthWithTiming(): Promise<
  ComponentHealthMetrics & {
    providers?: Record<string, "up" | "down" | "unknown">;
    healthyCount?: number;
    totalCount?: number;
  }
> {
  const { result: healthResult, metrics } = await measureHealthCheck(async () => {
    return await checkMobileMoneyHealth();
  }, "providers");

  if (metrics.status === "healthy" && healthResult) {
    const providers = healthResult.providers;
    const providerNames = Object.keys(providers) as ProviderName[];

    const providerStatus: Record<string, "up" | "down" | "unknown"> = {};
    let healthyCount = 0;

    for (const name of providerNames) {
      const status = providers[name]?.status ?? "unknown";
      providerStatus[name] = status;
      if (status === "up") healthyCount++;
    }

    return {
      ...metrics,
      providers: providerStatus,
      healthyCount,
      totalCount: providerNames.length,
    };
  }

  return metrics;
}

/**
 * Check replication status (if applicable)
 */
export async function checkReplicationHealth(): Promise<
  ComponentHealthMetrics & { drMode?: string }
> {
  const { result: replicationStatus, metrics } = await measureHealthCheck(async () => {
    // This is a placeholder - implement based on your replication setup
    // For now, assume healthy if no error
    return { status: "healthy", drMode: "active" };
  }, "replication");

  if (
    metrics.status === "healthy" &&
    replicationStatus &&
    "drMode" in replicationStatus
  ) {
    return {
      ...metrics,
      drMode: replicationStatus.drMode,
    };
  }

  return metrics;
}

/**
 * Check memory usage
 */
export function checkMemoryHealth(heapLimitMb: number = 1024): ComponentHealthMetrics {
  const memUsage = process.memoryUsage();
  const heapUsedMb = memUsage.heapUsed / 1024 / 1024;
  const heapLimitBytes = heapLimitMb * 1024 * 1024;

  let status: ComponentStatus = "healthy";
  if (heapUsedMb > heapLimitMb * 0.9) {
    status = "degraded";
  }
  if (memUsage.heapUsed > heapLimitBytes) {
    status = "down";
  }

  return {
    status,
    responseTime: 0, // Memory check is instant
    lastChecked: new Date().toISOString(),
    error: status !== "healthy" ? `Heap usage: ${heapUsedMb.toFixed(2)}MB / ${heapLimitMb}MB` : undefined,
  };
}

/**
 * Get comprehensive health check for all components
 */
export async function getDetailedComponentHealth(): Promise<ComponentHealthCheckResult> {
  const [database, redis, providers] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkProvidersHealthWithTiming(),
  ]);

  const replication = await checkReplicationHealth();
  const memory = checkMemoryHealth();

  return {
    database,
    redis,
    providers,
    replication,
    memory,
  };
}

/**
 * Determine overall system status
 */
export function determineOverallStatus(components: ComponentHealthCheckResult): "healthy" | "degraded" | "down" {
  const criticalComponents = [components.database, components.redis];
  const downComponents = criticalComponents.filter((c) => c.status === "down");

  if (downComponents.length > 0) {
    return "down";
  }

  const degradedComponents = [
    ...criticalComponents,
    components.providers,
    ...(components.replication ? [components.replication] : []),
    ...(components.memory ? [components.memory] : []),
  ].filter((c) => c.status === "degraded");

  return degradedComponents.length > 0 ? "degraded" : "healthy";
}
