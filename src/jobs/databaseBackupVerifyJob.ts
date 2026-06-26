import { restoreAndVerify } from "../services/backupService";

const PAGERDUTY_API = "https://events.pagerduty.com/v2/enqueue";
const INTEGRATION_KEY = process.env.PAGERDUTY_INTEGRATION_KEY ?? "";
const DEDUP_KEY = "proxypay-backup-restore-verify";

async function sendPagerDutyEvent(
  action: "trigger" | "resolve",
  summary: string,
  details: Record<string, unknown>,
): Promise<void> {
  if (!INTEGRATION_KEY) {
    console.warn("[backup-verify-job] PAGERDUTY_INTEGRATION_KEY not set — skipping PagerDuty event");
    return;
  }
  const res = await fetch(PAGERDUTY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      routing_key: INTEGRATION_KEY,
      event_action: action,
      dedup_key: DEDUP_KEY,
      payload: {
        summary,
        timestamp: new Date().toISOString(),
        severity: action === "trigger" ? "critical" : "info",
        source: "proxypay-backup-verify-job",
        custom_details: details,
      },
    }),
  });
  if (!res.ok) {
    console.error(`[backup-verify-job] PagerDuty API error ${res.status}: ${await res.text()}`);
  }
}

/**
 * Weekly backup restore-verification job.
 *
 * Downloads the latest encrypted backup from S3, decrypts it, restores it
 * into a temporary PostgreSQL database, runs data integrity checks, then
 * drops the temp database.  Triggers a PagerDuty CRITICAL incident on
 * failure and auto-resolves on success.
 */
export async function runDatabaseBackupVerifyJob(): Promise<void> {
  console.log("[backup-verify-job] Starting weekly backup restore verification...");
  const start = Date.now();

  let result;
  try {
    result = await restoreAndVerify();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[backup-verify-job] Unexpected error:", error);
    await sendPagerDutyEvent(
      "trigger",
      "[CRITICAL] Weekly backup restore verification threw an unexpected error",
      { error },
    );
    throw err;
  }

  const duration = ((Date.now() - start) / 1000).toFixed(2);

  if (result.success) {
    console.log(
      `[backup-verify-job] PASSED in ${duration}s — backup=${result.backupId}`,
      JSON.stringify(result.checks),
    );
    await sendPagerDutyEvent(
      "resolve",
      `[RESOLVED] Backup restore verification passed for ${result.backupId}`,
      { backupId: result.backupId, duration_s: duration, checks: result.checks },
    );
  } else {
    console.error(
      `[backup-verify-job] FAILED in ${duration}s — backup=${result.backupId || "unknown"}`,
      result.error ?? JSON.stringify(result.checks),
    );
    await sendPagerDutyEvent(
      "trigger",
      `[CRITICAL] Backup restore verification FAILED for ${result.backupId || "unknown backup"}`,
      {
        backupId: result.backupId,
        error: result.error,
        checks: result.checks,
        duration_s: duration,
      },
    );
    throw new Error(`Backup restore verification failed: ${result.error ?? "integrity check(s) failed"}`);
  }
}
