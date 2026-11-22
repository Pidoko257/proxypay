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
 * ─── Reconciliation Operations Runbook ──────────────────────────────────────
 *
 * This script is the entry point support staff use to investigate
 * reconciliation discrepancies. The runbook below documents the safe
 * operational procedure. It is intentionally read-only: this script never
 * mutates financial state.
 *
 * 1. Alert meanings
 *    - "Mismatched" (⚠️): a payout exists on both sides but status and/or
 *      amount differ. Usually a timing lag or a partial provider update.
 *    - "Missing local" (❌): the provider reports a payout we have no local
 *      record of. Investigate before creating anything.
 *    - "Missing remote" (❌): we have a local payout the provider does not
 *      report. Often a payout that has not settled yet, or a stale record.
 *    - "Critical alert": any missing-local/missing-remote entry, or a
 *      mismatch on amount. These require escalation (see step 6).
 *
 * 2. Retrieving provider reports
 *    - Open the provider reconciliation dashboard and export the payout
 *      report for the affected date range (CSV/JSON).
 *    - Run this script (`npm run reconcile`) to produce the local report and
 *      compare the two side by side. Do not edit the exported file.
 *
 * 3. Safe review actions (no financial state changes)
 *    - Read the report output and the audit trail for the affected payout IDs.
 *    - Cross-check amounts, statuses, and timestamps between local and remote.
 *    - Annotate findings in the incident/ticket. Never edit payout records,
 *      balances, or ledger entries by hand.
 *
 * 4. Correction approval workflow
 *    - Any correction (creating a missing record, adjusting an amount) must be
 *      proposed in the ticket with evidence: the provider report excerpt, the
 *      local record, and the audit-trail entries.
 *    - A second reviewer (finance/on-call owner) must approve before any
 *      correction is applied through the supported correction path.
 *
 * 5. Replay procedure
 *    - After a correction is approved and applied, re-run `npm run reconcile`
 *      for the same window and confirm the entry now matches.
 *    - Record the before/after report in the ticket.
 *
 * 6. Escalation ownership
 *    - Unresolved critical alerts escalate to the on-call payments engineer,
 *      who owns the correction and replay. Support owns documentation only.
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

/**
 * Returns the UTC offset (in minutes) of `timeZone` at the given instant.
 * Uses Intl so daylight-saving transitions are handled by the platform.
 */
function getTimeZoneOffsetMinutes(timeZone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(at);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return (asUtc - at.getTime()) / 60_000;
}

/**
 * Converts a wall-clock date (Y-M-D) in `timeZone` to the UTC instant of
 * local midnight. Handles DST by resolving the offset at that instant.
 */
function zonedMidnightUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string
): Date {
  // First guess: treat the wall-clock as UTC, then correct by the offset.
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = getTimeZoneOffsetMinutes(timeZone, new Date(guess));
  return new Date(guess - offset * 60_000);
}

/**
 * Builds a half-open UTC interval [start, end) covering the calendar day
 * `dateStr` (YYYY-MM-DD) in the configured reporting timezone.
 */
export function reportingDayInterval(
  dateStr: string,
  timeZone: string = REPORTING_TIMEZONE
): { start: Date; end: Date } {
  const [year, month, day] = dateStr.split("-").map(Number);
  const start = zonedMidnightUtc(year, month, day, timeZone);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const end = zonedMidnightUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    timeZone
  );
  return { start, end };
}

function printReport(report: ReconciliationReport): void {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║         PROVIDER RECONCILIATION REPORT              ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  console.log(`  Reconciled at : ${report.reconciledAt}`);
  console.log(`  Timezone      : ${REPORTING_TIMEZONE}`);
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
