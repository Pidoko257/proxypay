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
 */

import { reconcile } from "../services/reconciler";
import type { ReconciliationReport } from "../types/reconciliation";

// ─── Configuration ───────────────────────────────────────────────────────────

/** Interval between reconciliation passes in loop mode (ms). */
const LOOP_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS) || 60_000;

/**
 * Bounded concurrency policy for the reconciliation workload.
 *
 * Reconciliation is provider-heavy and must not starve payment or
 * notification queues, so it runs with a small concurrency budget and a
 * bounded queue capacity. When the queue saturates, new passes are
 * deferred (skipped) rather than piling up unbounded work.
 */
const RECONCILE_CONCURRENCY =
  Number(process.env.RECONCILE_CONCURRENCY) || 2;
const RECONCILE_QUEUE_CAPACITY =
  Number(process.env.RECONCILE_QUEUE_CAPACITY) || 10;

// ─── Saturation metrics ──────────────────────────────────────────────────────

interface ReconcileQueueMetrics {
  active: number;
  depth: number;
  capacity: number;
  concurrency: number;
  completed: number;
  deferred: number;
  rejected: number;
}

const metrics: ReconcileQueueMetrics = {
  active: 0,
  depth: 0,
  capacity: RECONCILE_QUEUE_CAPACITY,
  concurrency: RECONCILE_CONCURRENCY,
  completed: 0,
  deferred: 0,
  rejected: 0,
};

function logMetrics(): void {
  console.log(
    `[reconciler] queue metrics → active: ${metrics.active}, depth: ${metrics.depth}/${metrics.capacity}, ` +
      `concurrency: ${metrics.concurrency}, completed: ${metrics.completed}, ` +
      `deferred: ${metrics.deferred}, rejected: ${metrics.rejected}`
  );
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

async function runOnce(): Promise<void> {
  // Admission control: defer when the queue is saturated.
  if (metrics.active >= metrics.concurrency || metrics.depth >= metrics.capacity) {
    metrics.deferred += 1;
    console.warn(
      "[reconciler] queue saturated — deferring reconciliation pass"
    );
    logMetrics();
    return;
  }

  metrics.active += 1;
  metrics.depth += 1;

  try {
    const report = await reconcile();
    printReport(report);
    metrics.completed += 1;
  } catch (err) {
    console.error("[reconciler] Reconciliation failed:", err);
    process.exitCode = 1;
  } finally {
    metrics.active -= 1;
    metrics.depth -= 1;
    logMetrics();
  }
}

async function runLoop(): Promise<void> {
  console.log(
    `[reconciler] Starting reconciliation loop (interval: ${LOOP_INTERVAL_MS / 1000}s) …`
  );
  console.log(
    `[reconciler] Bounded queue: concurrency=${RECONCILE_CONCURRENCY}, capacity=${RECONCILE_QUEUE_CAPACITY}`
  );
  console.log("[reconciler] Press Ctrl+C to stop.\n");

  // Run immediately on start, then on the interval
  await runOnce();

  setInterval(async () => {
    await runOnce();
  }, LOOP_INTERVAL_MS);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const isLoop = process.argv.includes("--loop");

if (isLoop) {
  runLoop();
} else {
  runOnce();
}
