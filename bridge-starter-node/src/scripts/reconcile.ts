/**
 * Reconciliation runner script.
 *
 * Can be executed directly:
 *   npx ts-node-dev src/scripts/reconcile.ts          (one-shot)
 *   npx ts-node-dev src/scripts/reconcile.ts --loop   (continuous, every 60 s)
 *
 * Or via the npm script added to package.json:
 *   npm run reconcile            (one-shot)
 *   npm run reconcile:loop       (continuous)
 *
 * When multiple replicas run this script, a per-job distributed lease
 * (PostgreSQL advisory lock) ensures only one replica executes a given
 * reconciliation pass at a time. The lease is renewed while the job runs
 * and a fencing token guards against stale lock holders.
 */

import { reconcile } from "../services/reconciler";
import type { ReconciliationReport } from "../types/reconciliation";

// ─── Configuration ───────────────────────────────────────────────────────────

/** Interval between reconciliation passes in loop mode (ms). */
const LOOP_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS) || 60_000;

/** Stable identifier for the reconciliation job used for distributed locking. */
const JOB_NAME = "reconcile";

/** Lease duration before another replica may steal the lock (ms). */
const LEASE_TTL_MS = Number(process.env.RECONCILE_LEASE_TTL_MS) || 120_000;

/** How often the lease is renewed while the job runs (ms). */
const LEASE_RENEW_MS = Number(process.env.RECONCILE_LEASE_RENEW_MS) || 30_000;

// ─── Distributed lease (PostgreSQL advisory locks) ───────────────────────────

/**
 * Minimal client surface required to acquire/renew/release a lease.
 * Implemented against PostgreSQL advisory locks; injected so the scheduler
 * can be tested with an in-memory fake.
 */
export interface LeaseClient {
  /** Try to acquire the lock for `key`. Returns a fencing token or null if held. */
  tryAcquire(key: string, ttlMs: number): Promise<number | null>;
  /** Renew an existing lease. Returns false if the lease was lost. */
  renew(key: string, token: number, ttlMs: number): Promise<boolean>;
  /** Release the lease if still owned by `token`. */
  release(key: string, token: number): Promise<void>;
}

/**
 * PostgreSQL advisory-lock backed lease client.
 *
 * Uses `pg_try_advisory_lock` for acquisition and a monotonically increasing
 * fencing token stored alongside the lock so stale holders can be detected.
 */
export function createPostgresLeaseClient(pool: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): LeaseClient {
  return {
    async tryAcquire(key, ttlMs) {
      const { rows } = await pool.query(
        `INSERT INTO scheduler_leases (job_name, token, expires_at)
         VALUES ($1, nextval('scheduler_lease_token_seq'), now() + ($2 || ' milliseconds')::interval)
         ON CONFLICT (job_name) DO UPDATE
           SET token = nextval('scheduler_lease_token_seq'),
               expires_at = now() + ($2 || ' milliseconds')::interval
           WHERE scheduler_leases.expires_at < now()
         RETURNING token`,
        [key, ttlMs]
      );
      const token = rows[0]?.token;
      return typeof token === "number" ? token : null;
    },
    async renew(key, token, ttlMs) {
      const { rows } = await pool.query(
        `UPDATE scheduler_leases
            SET expires_at = now() + ($3 || ' milliseconds')::interval
          WHERE job_name = $1 AND token = $2 AND expires_at > now()
          RETURNING token`,
        [key, token, ttlMs]
      );
      return rows.length > 0;
    },
    async release(key, token) {
      await pool.query(
        `DELETE FROM scheduler_leases WHERE job_name = $1 AND token = $2`,
        [key, token]
      );
    },
  };
}

/**
 * Run `job` under a distributed lease so only one replica executes it.
 * Records skipped/started executions and renews the lease while running.
 */
export async function runWithLease(
  client: LeaseClient,
  jobName: string,
  job: () => Promise<void>
): Promise<"started" | "skipped"> {
  const token = await client.tryAcquire(jobName, LEASE_TTL_MS);
  if (token === null) {
    console.log(`[scheduler] Skipped ${jobName}: lease held by another replica`);
    return "skipped";
  }

  console.log(`[scheduler] Started ${jobName} (fencing token: ${token})`);

  let lost = false;
  const renewTimer = setInterval(async () => {
    try {
      const ok = await client.renew(jobName, token, LEASE_TTL_MS);
      if (!ok) {
        lost = true;
        console.warn(`[scheduler] Lost lease for ${jobName} (token: ${token})`);
      }
    } catch (err) {
      console.error(`[scheduler] Lease renewal failed for ${jobName}:`, err);
    }
  }, LEASE_RENEW_MS);

  try {
    if (lost) {
      throw new Error(`Lease for ${jobName} lost before execution`);
    }
    await job();
  } finally {
    clearInterval(renewTimer);
    await client.release(jobName, token).catch((err) => {
      console.error(`[scheduler] Failed to release lease for ${jobName}:`, err);
    });
  }

  return "started";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function printReport(report: ReconciliationReport): void {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║         PROVIDER RECONCILIATION REPORT              ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  console.log(`  Reconciled at : ${report.reconciledAt}`);
  console.log(`  Local records : ${report.totalLocal}`);
  console.log(`  Remote records: ${report.totalRemote}`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  ✅ Matched      : ${report.matched}`);
  console.log(`  ⚠️  Mismatched   : ${report.mismatched}`);
  console.log(`  ❌ Missing local : ${report.missingLocal}`);
  console.log(`  ❌ Missing remote: ${report.missingRemote}`);

  if (report.entries.length > 0) {
    console.log("\n  ── Entry Details ──────────────────────────────────\n");

    for (const entry of report.entries) {
      const icon = entry.match ? "✅" : "⚠️";
      console.log(`  ${icon} [${entry.payoutId}]`);
      console.log(
        `     local  → status: ${entry.localStatus ?? "—"}, amount: ${entry.localAmount ?? "—"}`
      );
      console.log(
        `     remote → status: ${entry.remoteStatus ?? "—"}, amount: ${entry.remoteAmount ?? "—"}`
      );
      if (entry.discrepancy) {
        console.log(`     ⤷ ${entry.discrepancy}`);
      }
    }
  } else {
    console.log("\n  No payout records found on either side.");
    console.log(
      "  → Implement fetchLocalPayouts() and fetchRemotePayouts()"
    );
    console.log(
      "    in src/services/reconciler.ts to connect your data sources.\n"
    );
  }

  console.log("");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runOnce(leaseClient?: LeaseClient): Promise<void> {
  const execute = async (): Promise<void> => {
    try {
      const report = await reconcile();
      printReport(report);
    } catch (err) {
      console.error("[reconciler] Reconciliation failed:", err);
      process.exitCode = 1;
    }
  };

  if (!leaseClient) {
    await execute();
    return;
  }

  try {
    await runWithLease(leaseClient, JOB_NAME, execute);
  } catch (err) {
    console.error("[reconciler] Lease-guarded run failed:", err);
    process.exitCode = 1;
  }
}

async function runLoop(leaseClient?: LeaseClient): Promise<void> {
  console.log(
    `[reconciler] Starting reconciliation loop (interval: ${LOOP_INTERVAL_MS / 1000}s) …`
  );
  console.log("[reconciler] Press Ctrl+C to stop.\n");

  // Run immediately on start, then on the interval
  await runOnce(leaseClient);

  setInterval(async () => {
    await runOnce(leaseClient);
  }, LOOP_INTERVAL_MS);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const isLoop = process.argv.includes("--loop");

if (isLoop) {
  runLoop();
} else {
  runOnce();
}
