export type DependencyName = 'postgres' | 'redis' | 'horizon' | 'providers';

export type DependencyStatus = 'up' | 'down';

export interface DependencyCheck {
  name: DependencyName;
  status: DependencyStatus;
  /** Safe, non-sensitive detail (e.g. "timeout", "unreachable"). Never raw errors or connection strings. */
  detail?: string;
}

export interface LivenessResult {
  status: 'alive';
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessResult {
  status: 'ready' | 'not_ready';
  dependencies: DependencyCheck[];
  timestamp: string;
}

/**
 * Liveness dependency set: intentionally empty. A process is alive if it can
 * respond; PostgreSQL, Redis, Horizon, and providers must NOT affect liveness.
 */
export const LIVENESS_DEPENDENCIES: readonly DependencyName[] = [];

/**
 * Readiness dependency set: every dependency required to accept payment
 * traffic. If any is down, the process is not ready.
 */
export const READINESS_DEPENDENCIES: readonly DependencyName[] = [
  'postgres',
  'redis',
  'horizon',
  'providers',
];

export type DependencyProbe = () => Promise<boolean>;

export type DependencyProbes = Partial<Record<DependencyName, DependencyProbe>>;

const startedAt = Date.now();

/**
 * Liveness check. Reports only process health and never touches external
 * dependencies, so orchestrators do not restart a healthy process during a
 * partial outage.
 */
export function checkLiveness(): LivenessResult {
  return {
    status: 'alive',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  };
}

async function runProbe(name: DependencyName, probe?: DependencyProbe): Promise<DependencyCheck> {
  if (!probe) {
    return { name, status: 'down', detail: 'not_configured' };
  }
  try {
    const ok = await probe();
    return ok ? { name, status: 'up' } : { name, status: 'down', detail: 'unhealthy' };
  } catch {
    // Swallow the raw error to avoid leaking internals; expose a safe detail.
    return { name, status: 'down', detail: 'check_failed' };
  }
}

/**
 * Readiness check. Runs every probe in the readiness dependency set and
 * returns not_ready if any required dependency is down. Details are safe and
 * contain no secrets, connection strings, or raw error internals.
 */
export async function checkReadiness(probes: DependencyProbes): Promise<ReadinessResult> {
  const dependencies = await Promise.all(
    READINESS_DEPENDENCIES.map((name) => runProbe(name, probes[name])),
  );
  const ready = dependencies.every((dep) => dep.status === 'up');
  return {
    status: ready ? 'ready' : 'not_ready',
    dependencies,
    timestamp: new Date().toISOString(),
  };
}
