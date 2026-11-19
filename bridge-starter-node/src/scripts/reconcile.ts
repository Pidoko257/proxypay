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
  try {
    const report = await reconcile();
    printReport(report);
  } catch (err) {
    console.error("[reconciler] Reconciliation failed:", err);
    process.exitCode = 1;
  }
}

async function runLoop(): Promise<void> {
  console.log(
    `[reconciler] Starting reconciliation loop (interval: ${LOOP_INTERVAL_MS / 1000}s) …`
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
