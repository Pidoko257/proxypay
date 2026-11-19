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
 * Reporting timezone used to derive the reconciliation window.
 * Defaults to UTC so boundaries never depend on the host's application time.
 */
const REPORTING_TIMEZONE = process.env.REPORTING_TIMEZONE || "UTC";

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

async function runOnce(): Promise<void> {
  try {
    // Derive the reconciliation window from the reporting timezone rather
    // than the host's application time, so records are classified correctly
    // across provider/customer timezones.
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: REPORTING_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const { start, end } = reportingDayInterval(today, REPORTING_TIMEZONE);
    console.log(
      `[reconciler] Window (${REPORTING_TIMEZONE}): ${start.toISOString()} → ${end.toISOString()} (half-open)`
    );

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
