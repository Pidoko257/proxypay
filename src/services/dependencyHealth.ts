import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import { getHorizonUrls, getStellarServer } from "../config/stellar";
import {
  checkMobileMoneyHealth,
  DEFAULT_PROVIDERS,
  type ProviderConfig,
} from "./mobilemoney/providers/healthCheck";

/** Per-dependency timeout — acceptance criteria require 3 seconds max. */
export const DEPENDENCY_TIMEOUT_MS = 3_000;

export type DependencyStatus = "up" | "down";

export interface DependencyCheckResult {
  name: string;
  status: DependencyStatus;
  latency_ms: number;
}

export interface DependencyHealthReport {
  status: "ok" | "degraded";
  timestamp: string;
  dependencies: DependencyCheckResult[];
  gitHash?: string;
}

export type DependencyChecker = () => Promise<void>;

export interface DependencyHealthDeps {
  checkPostgres?: DependencyChecker;
  checkRedis?: DependencyChecker;
  checkBullmq?: DependencyChecker;
  checkHorizon?: DependencyChecker;
  checkMomo?: DependencyChecker;
  now?: () => number;
  timeoutMs?: number;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Health check timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function defaultCheckPostgres(): Promise<void> {
  await pool.query("SELECT 1");
}

async function defaultCheckRedis(): Promise<void> {
  if (!redisClient?.isOpen) {
    throw new Error("Redis client is not connected");
  }
  await redisClient.ping();
}

async function defaultCheckBullmq(): Promise<void> {
  // Lazy-load so importing this module (e.g. in unit tests) does not open a
  // BullMQ Redis connection until the live checker actually runs.
  const { syncQueue } = await import("../queue/syncQueue");
  await syncQueue.getWaitingCount();
}

async function defaultCheckHorizon(): Promise<void> {
  // Prefer the SDK feeStats probe; fall back to a raw Horizon root GET.
  const server = getStellarServer() as {
    feeStats?: () => Promise<unknown>;
  };
  if (typeof server.feeStats === "function") {
    await server.feeStats();
    return;
  }

  const [url] = getHorizonUrls();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Horizon HTTP ${response.status}`);
  }
}

async function defaultCheckMomo(): Promise<void> {
  const providers: ProviderConfig[] = DEFAULT_PROVIDERS.map((p) => ({
    ...p,
    timeoutMs: DEPENDENCY_TIMEOUT_MS,
  }));
  const result = await checkMobileMoneyHealth(providers);
  const down = Object.entries(result.providers).filter(
    ([, health]) => health.status === "down",
  );
  if (down.length > 0) {
    throw new Error(
      `MoMo provider(s) down: ${down.map(([name]) => name).join(", ")}`,
    );
  }
}

async function runTimedCheck(
  name: string,
  checker: DependencyChecker,
  timeoutMs: number,
  now: () => number,
): Promise<DependencyCheckResult> {
  const started = now();
  try {
    await withTimeout(checker(), timeoutMs);
    return {
      name,
      status: "up",
      latency_ms: Math.max(0, now() - started),
    };
  } catch {
    return {
      name,
      status: "down",
      latency_ms: Math.max(0, now() - started),
    };
  }
}

/**
 * Probe critical runtime dependencies in parallel and build a structured
 * health report for GET /health.
 */
export async function runDependencyHealthChecks(
  deps: DependencyHealthDeps = {},
): Promise<DependencyHealthReport> {
  const timeoutMs = deps.timeoutMs ?? DEPENDENCY_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  const checks: Array<{ name: string; checker: DependencyChecker }> = [
    { name: "postgresql", checker: deps.checkPostgres ?? defaultCheckPostgres },
    { name: "redis", checker: deps.checkRedis ?? defaultCheckRedis },
    { name: "bullmq", checker: deps.checkBullmq ?? defaultCheckBullmq },
    {
      name: "stellar_horizon",
      checker: deps.checkHorizon ?? defaultCheckHorizon,
    },
    { name: "momo", checker: deps.checkMomo ?? defaultCheckMomo },
  ];

  const dependencies = await Promise.all(
    checks.map(({ name, checker }) =>
      runTimedCheck(name, checker, timeoutMs, now),
    ),
  );

  const allUp = dependencies.every((d) => d.status === "up");

  return {
    status: allUp ? "ok" : "degraded",
    timestamp: new Date(now()).toISOString(),
    dependencies,
    gitHash: process.env.BUILD_HASH,
  };
}
