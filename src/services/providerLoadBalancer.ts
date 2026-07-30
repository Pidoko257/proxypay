/**
 * Provider Load Balancer Service
 *
 * Implements intelligent load balancing across multiple mobile money provider
 * connections for improved reliability and performance.
 *
 * Features:
 *   - Round-robin routing with health-aware skipping
 *   - Provider capacity tracking and dynamic routing
 *   - Sticky sessions for stateful operations
 *   - Load balancing metrics and observability
 *   - Configurable via admin API
 *
 * Issue: #203
 */

import { pool } from "../config/database";
import { redisClient } from "../config/redis";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderName = "mtn" | "airtel" | "orange";
export type RoutingStrategy = "round_robin" | "least_connections" | "weighted" | "random";
export type ProviderHealthStatus = "healthy" | "degraded" | "unhealthy";

export interface ProviderCapacity {
  provider: ProviderName;
  maxConcurrentRequests: number;
  currentLoad: number;
  weight: number;               // For weighted routing (1–100)
  isEnabled: boolean;
  healthStatus: ProviderHealthStatus;
  consecutiveFailures: number;
  lastHealthCheck: Date | null;
  avgResponseTimeMs: number | null;
}

export interface LoadBalancerConfig {
  strategy: RoutingStrategy;
  healthCheckIntervalMs: number;
  failureThreshold: number;        // Failures before marking unhealthy
  recoveryThreshold: number;       // Consecutive successes before marking healthy
  stickySessionTtlSeconds: number; // 0 = disabled
}

export interface RouteDecision {
  provider: ProviderName;
  reason: string;
  isStickySession: boolean;
}

export interface LoadBalancerMetrics {
  totalRequests: number;
  requestsPerProvider: Record<ProviderName, number>;
  failuresPerProvider: Record<ProviderName, number>;
  avgResponseTimeMs: Record<ProviderName, number | null>;
  currentLoadPerProvider: Record<ProviderName, number>;
  healthStatusPerProvider: Record<ProviderName, ProviderHealthStatus>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Redis key helpers
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_PREFIX = "lb:";
const rrCounterKey = () => `${REDIS_PREFIX}rr_counter`;
const stickyKey = (sessionId: string) => `${REDIS_PREFIX}sticky:${sessionId}`;
const loadKey = (provider: ProviderName) => `${REDIS_PREFIX}load:${provider}`;
const metricsKey = (provider: ProviderName) => `${REDIS_PREFIX}metrics:${provider}`;
const configKey = () => `${REDIS_PREFIX}config`;

// ─────────────────────────────────────────────────────────────────────────────
// In-memory fallback state
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: LoadBalancerConfig = {
  strategy: "round_robin",
  healthCheckIntervalMs: 30_000,
  failureThreshold: 3,
  recoveryThreshold: 2,
  stickySessionTtlSeconds: 300,
};

const ALL_PROVIDERS: ProviderName[] = ["mtn", "airtel", "orange"];

// In-memory capacity state (authoritative for current process)
const capacityMap = new Map<ProviderName, ProviderCapacity>(
  ALL_PROVIDERS.map((name) => [
    name,
    {
      provider: name,
      maxConcurrentRequests: 100,
      currentLoad: 0,
      weight: 33,
      isEnabled: true,
      healthStatus: "healthy",
      consecutiveFailures: 0,
      lastHealthCheck: null,
      avgResponseTimeMs: null,
    },
  ]),
);

let rrIndex = 0; // Round-robin counter (in-process fallback)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getConfig(): Promise<LoadBalancerConfig> {
  try {
    if (redisClient?.isOpen) {
      const raw = await redisClient.get(configKey());
      if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch {
    // Fall through to default
  }
  return DEFAULT_CONFIG;
}

async function getLoad(provider: ProviderName): Promise<number> {
  try {
    if (redisClient?.isOpen) {
      const raw = await redisClient.get(loadKey(provider));
      if (raw !== null) return parseInt(raw, 10);
    }
  } catch {
    // Fall through
  }
  return capacityMap.get(provider)?.currentLoad ?? 0;
}

async function incrementLoad(provider: ProviderName): Promise<void> {
  const cap = capacityMap.get(provider);
  if (cap) cap.currentLoad += 1;
  try {
    if (redisClient?.isOpen) {
      await redisClient.incr(loadKey(provider));
    }
  } catch {
    // Non-fatal
  }
}

async function decrementLoad(provider: ProviderName): Promise<void> {
  const cap = capacityMap.get(provider);
  if (cap && cap.currentLoad > 0) cap.currentLoad -= 1;
  try {
    if (redisClient?.isOpen) {
      const val = await redisClient.decr(loadKey(provider));
      if (val < 0) await redisClient.set(loadKey(provider), "0");
    }
  } catch {
    // Non-fatal
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core load balancer
// ─────────────────────────────────────────────────────────────────────────────

export class ProviderLoadBalancer {
  /**
   * Select the best provider for the next request.
   *
   * @param sessionId  Optional session identifier for sticky routing.
   */
  async selectProvider(sessionId?: string): Promise<RouteDecision> {
    // 1. Check sticky session
    if (sessionId) {
      const sticky = await this.getStickySession(sessionId);
      if (sticky) {
        const cap = capacityMap.get(sticky);
        if (cap && cap.isEnabled && cap.healthStatus !== "unhealthy") {
          return { provider: sticky, reason: "sticky_session", isStickySession: true };
        }
      }
    }

    // 2. Get available (healthy / degraded but enabled) providers
    const available = ALL_PROVIDERS.filter((p) => {
      const cap = capacityMap.get(p);
      return cap && cap.isEnabled && cap.healthStatus !== "unhealthy";
    });

    if (available.length === 0) {
      throw new Error("No healthy providers available");
    }

    const config = await getConfig();
    let selected: ProviderName;

    switch (config.strategy) {
      case "weighted":
        selected = await this.selectWeighted(available);
        break;
      case "least_connections":
        selected = await this.selectLeastConnections(available);
        break;
      case "random":
        selected = available[Math.floor(Math.random() * available.length)];
        break;
      case "round_robin":
      default:
        selected = await this.selectRoundRobin(available);
    }

    // Store sticky session if configured
    if (sessionId && config.stickySessionTtlSeconds > 0) {
      await this.setStickySession(sessionId, selected, config.stickySessionTtlSeconds);
    }

    return {
      provider: selected,
      reason: config.strategy,
      isStickySession: false,
    };
  }

  /**
   * Signal that a request to a provider has started.
   * Must be paired with recordRequestComplete / recordRequestFailure.
   */
  async recordRequestStart(provider: ProviderName): Promise<void> {
    await incrementLoad(provider);
  }

  /**
   * Signal that a request completed successfully.
   */
  async recordRequestComplete(provider: ProviderName, durationMs: number): Promise<void> {
    await decrementLoad(provider);
    await this.updateMetrics(provider, true, durationMs);

    const cap = capacityMap.get(provider);
    if (!cap) return;

    // Reset failure streak on success
    cap.consecutiveFailures = 0;
    if (cap.healthStatus === "degraded") {
      const config = await getConfig();
      // Track consecutive successes towards recovery
      const key = `${REDIS_PREFIX}recovery:${provider}`;
      let successes = 0;
      try {
        if (redisClient?.isOpen) {
          successes = await redisClient.incr(key);
          await redisClient.expire(key, 60);
        }
      } catch {
        successes = 1;
      }
      if (successes >= config.recoveryThreshold) {
        cap.healthStatus = "healthy";
        try {
          if (redisClient?.isOpen) await redisClient.del(key);
        } catch { /* no-op */ }
        await this.persistCapacity(cap);
      }
    }
  }

  /**
   * Signal that a request to a provider failed.
   */
  async recordRequestFailure(provider: ProviderName): Promise<void> {
    await decrementLoad(provider);
    await this.updateMetrics(provider, false, null);

    const cap = capacityMap.get(provider);
    if (!cap) return;

    cap.consecutiveFailures += 1;
    const config = await getConfig();

    if (cap.consecutiveFailures >= config.failureThreshold) {
      cap.healthStatus = cap.healthStatus === "healthy" ? "degraded" : "unhealthy";
    }

    await this.persistCapacity(cap);
  }

  // ─── Health management ────────────────────────────────────────────────────

  async updateProviderHealth(
    provider: ProviderName,
    status: ProviderHealthStatus,
    avgResponseTimeMs?: number,
  ): Promise<void> {
    const cap = capacityMap.get(provider);
    if (!cap) return;

    cap.healthStatus = status;
    cap.lastHealthCheck = new Date();
    if (avgResponseTimeMs !== undefined) cap.avgResponseTimeMs = avgResponseTimeMs;

    if (status === "healthy") cap.consecutiveFailures = 0;

    await this.persistCapacity(cap);
  }

  // ─── Configuration API ────────────────────────────────────────────────────

  async getLoadBalancerConfig(): Promise<LoadBalancerConfig> {
    return getConfig();
  }

  async updateLoadBalancerConfig(
    updates: Partial<LoadBalancerConfig>,
  ): Promise<LoadBalancerConfig> {
    const current = await getConfig();
    const updated = { ...current, ...updates };

    try {
      if (redisClient?.isOpen) {
        await redisClient.set(configKey(), JSON.stringify(updated));
      }
    } catch { /* Non-fatal */ }

    await pool.query(
      `INSERT INTO load_balancer_config (key, value, updated_at)
       VALUES ('default', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(updated)],
    );

    return updated;
  }

  async getProviderCapacities(): Promise<ProviderCapacity[]> {
    return ALL_PROVIDERS.map((p) => capacityMap.get(p)!);
  }

  async updateProviderCapacity(
    provider: ProviderName,
    updates: Partial<Pick<ProviderCapacity, "maxConcurrentRequests" | "weight" | "isEnabled">>,
  ): Promise<ProviderCapacity> {
    const cap = capacityMap.get(provider);
    if (!cap) throw new Error(`Unknown provider: ${provider}`);

    if (updates.maxConcurrentRequests !== undefined)
      cap.maxConcurrentRequests = updates.maxConcurrentRequests;
    if (updates.weight !== undefined) cap.weight = updates.weight;
    if (updates.isEnabled !== undefined) cap.isEnabled = updates.isEnabled;

    await this.persistCapacity(cap);
    return cap;
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────

  async getMetrics(): Promise<LoadBalancerMetrics> {
    const metrics: LoadBalancerMetrics = {
      totalRequests: 0,
      requestsPerProvider: { mtn: 0, airtel: 0, orange: 0 },
      failuresPerProvider: { mtn: 0, airtel: 0, orange: 0 },
      avgResponseTimeMs: { mtn: null, airtel: null, orange: null },
      currentLoadPerProvider: { mtn: 0, airtel: 0, orange: 0 },
      healthStatusPerProvider: { mtn: "healthy", airtel: "healthy", orange: "healthy" },
    };

    for (const provider of ALL_PROVIDERS) {
      const cap = capacityMap.get(provider)!;
      metrics.currentLoadPerProvider[provider] = await getLoad(provider);
      metrics.healthStatusPerProvider[provider] = cap.healthStatus;
      metrics.avgResponseTimeMs[provider] = cap.avgResponseTimeMs;

      try {
        const row = await pool.query<{ total: string; failures: string; avg_ms: string | null }>(
          `SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE success = false) AS failures,
             AVG(duration_ms) AS avg_ms
           FROM provider_load_balancer_metrics
           WHERE provider = $1`,
          [provider],
        );
        if (row.rows.length > 0) {
          const r = row.rows[0];
          const total = parseInt(r.total, 10);
          metrics.requestsPerProvider[provider] = total;
          metrics.failuresPerProvider[provider] = parseInt(r.failures, 10);
          metrics.totalRequests += total;
          if (r.avg_ms !== null) {
            metrics.avgResponseTimeMs[provider] = Math.round(parseFloat(r.avg_ms));
          }
        }
      } catch {
        // DB might not have table yet — skip
      }
    }

    return metrics;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async selectRoundRobin(available: ProviderName[]): Promise<ProviderName> {
    let idx = 0;
    try {
      if (redisClient?.isOpen) {
        const rawIdx = await redisClient.incr(rrCounterKey());
        idx = (rawIdx - 1) % available.length;
      } else {
        idx = rrIndex % available.length;
        rrIndex += 1;
      }
    } catch {
      idx = rrIndex % available.length;
      rrIndex += 1;
    }
    return available[idx];
  }

  private async selectWeighted(available: ProviderName[]): Promise<ProviderName> {
    const weights = available.map((p) => capacityMap.get(p)?.weight ?? 33);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let rand = Math.random() * totalWeight;
    for (let i = 0; i < available.length; i++) {
      rand -= weights[i];
      if (rand <= 0) return available[i];
    }
    return available[available.length - 1];
  }

  private async selectLeastConnections(available: ProviderName[]): Promise<ProviderName> {
    let minLoad = Infinity;
    let selected = available[0];

    for (const provider of available) {
      const load = await getLoad(provider);
      if (load < minLoad) {
        minLoad = load;
        selected = provider;
      }
    }
    return selected;
  }

  private async getStickySession(sessionId: string): Promise<ProviderName | null> {
    try {
      if (redisClient?.isOpen) {
        const raw = await redisClient.get(stickyKey(sessionId));
        if (raw && ALL_PROVIDERS.includes(raw as ProviderName)) {
          return raw as ProviderName;
        }
      }
    } catch { /* no-op */ }
    return null;
  }

  private async setStickySession(
    sessionId: string,
    provider: ProviderName,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      if (redisClient?.isOpen) {
        await redisClient.setEx(stickyKey(sessionId), ttlSeconds, provider);
      }
    } catch { /* non-fatal */ }
  }

  private async updateMetrics(
    provider: ProviderName,
    success: boolean,
    durationMs: number | null,
  ): Promise<void> {
    // Update in-memory avg response time
    const cap = capacityMap.get(provider);
    if (cap && durationMs !== null) {
      cap.avgResponseTimeMs =
        cap.avgResponseTimeMs === null
          ? durationMs
          : Math.round((cap.avgResponseTimeMs * 0.9 + durationMs * 0.1));
    }

    try {
      await pool.query(
        `INSERT INTO provider_load_balancer_metrics (provider, success, duration_ms, recorded_at)
         VALUES ($1, $2, $3, NOW())`,
        [provider, success, durationMs],
      );
    } catch {
      // Table may not exist; non-fatal
    }
  }

  private async persistCapacity(cap: ProviderCapacity): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO provider_capacity_config
           (provider, max_concurrent_requests, weight, is_enabled, health_status,
            consecutive_failures, last_health_check, avg_response_time_ms, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (provider) DO UPDATE SET
           max_concurrent_requests = EXCLUDED.max_concurrent_requests,
           weight                  = EXCLUDED.weight,
           is_enabled              = EXCLUDED.is_enabled,
           health_status           = EXCLUDED.health_status,
           consecutive_failures    = EXCLUDED.consecutive_failures,
           last_health_check       = EXCLUDED.last_health_check,
           avg_response_time_ms    = EXCLUDED.avg_response_time_ms,
           updated_at              = EXCLUDED.updated_at`,
        [
          cap.provider,
          cap.maxConcurrentRequests,
          cap.weight,
          cap.isEnabled,
          cap.healthStatus,
          cap.consecutiveFailures,
          cap.lastHealthCheck,
          cap.avgResponseTimeMs,
        ],
      );
    } catch {
      // Non-fatal if migration hasn't run yet
    }
  }
}

export const providerLoadBalancer = new ProviderLoadBalancer();
