import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { createClient } from 'redis';

/**
 * Health endpoints.
 *
 * Liveness  (/health/live)  — process-only. Must never touch PostgreSQL, Redis,
 *                             Horizon or providers. A failing dependency must not
 *                             cause the orchestrator to restart a healthy process.
 * Readiness (/health/ready) — dependency set. Reports not-ready when any required
 *                             dependency is unhealthy so traffic is withheld.
 */

export type DependencyName = 'postgres' | 'redis' | 'horizon' | 'providers';

export type DependencyStatus = 'up' | 'down';

export interface DependencyResult {
  status: DependencyStatus;
  /** Safe, non-sensitive detail (e.g. "timeout", "unreachable"). Never raw errors. */
  detail?: string;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  dependencies: Record<DependencyName, DependencyResult>;
}

/**
 * Explicit dependency sets so the liveness/readiness distinction is testable.
 * Liveness intentionally has no dependencies.
 */
export const LIVENESS_DEPENDENCIES: readonly DependencyName[] = [];
export const READINESS_DEPENDENCIES: readonly DependencyName[] = [
  'postgres',
  'redis',
  'horizon',
  'providers',
];

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Map any thrown error to a safe detail string — never leak internals. */
function safeDetail(err: unknown): string {
  if (err instanceof Error && err.message === 'timeout') return 'timeout';
  return 'unreachable';
}

async function checkPostgres(): Promise<DependencyResult> {
  const url = process.env.DATABASE_URL;
  if (!url) return { status: 'down', detail: 'not_configured' };
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: CHECK_TIMEOUT_MS });
  try {
    await withTimeout(pool.query('SELECT 1'), CHECK_TIMEOUT_MS);
    return { status: 'up' };
  } catch (err) {
    return { status: 'down', detail: safeDetail(err) };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function checkRedis(): Promise<DependencyResult> {
  const url = process.env.REDIS_URL;
  if (!url) return { status: 'down', detail: 'not_configured' };
  const client = createClient({ url, socket: { connectTimeout: CHECK_TIMEOUT_MS } });
  client.on('error', () => undefined);
  try {
    await withTimeout(client.connect(), CHECK_TIMEOUT_MS);
    await withTimeout(client.ping(), CHECK_TIMEOUT_MS);
    return { status: 'up' };
  } catch (err) {
    return { status: 'down', detail: safeDetail(err) };
  } finally {
    await client.quit().catch(() => undefined);
  }
}

async function checkHorizon(): Promise<DependencyResult> {
  const url = process.env.HORIZON_URL;
  if (!url) return { status: 'down', detail: 'not_configured' };
  try {
    const res = await withTimeout(fetch(url, { method: 'GET' }), CHECK_TIMEOUT_MS);
    return res.ok ? { status: 'up' } : { status: 'down', detail: 'unhealthy' };
  } catch (err) {
    return { status: 'down', detail: safeDetail(err) };
  }
}

async function checkProviders(): Promise<DependencyResult> {
  // Providers are considered configured when a provider URL is present.
  const url = process.env.PROVIDER_URL;
  if (!url) return { status: 'down', detail: 'not_configured' };
  try {
    const res = await withTimeout(fetch(url, { method: 'GET' }), CHECK_TIMEOUT_MS);
    return res.ok ? { status: 'up' } : { status: 'down', detail: 'unhealthy' };
  } catch (err) {
    return { status: 'down', detail: safeDetail(err) };
  }
}

const CHECKS: Record<DependencyName, () => Promise<DependencyResult>> = {
  postgres: checkPostgres,
  redis: checkRedis,
  horizon: checkHorizon,
  providers: checkProviders,
};

async function runChecks(names: readonly DependencyName[]): Promise<Record<DependencyName, DependencyResult>> {
  const results = await Promise.all(
    names.map(async (name) => [name, await CHECKS[name]()] as const),
  );
  return Object.fromEntries(results) as Record<DependencyName, DependencyResult>;
}

const router = Router();

/** Liveness: process-only, no dependency checks. */
router.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'alive' });
});

/** Readiness: checks the full dependency set. */
router.get('/ready', async (_req: Request, res: Response) => {
  const dependencies = await runChecks(READINESS_DEPENDENCIES);
  const ready = READINESS_DEPENDENCIES.every((name) => dependencies[name].status === 'up');
  const report: ReadinessReport = {
    status: ready ? 'ready' : 'not_ready',
    dependencies,
  };
  res.status(ready ? 200 : 503).json(report);
});

/** Backwards-compatible aggregate health endpoint. */
router.get('/', async (_req: Request, res: Response) => {
  const dependencies = await runChecks(READINESS_DEPENDENCIES);
  const ready = READINESS_DEPENDENCIES.every((name) => dependencies[name].status === 'up');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', dependencies });
});

export default router;
