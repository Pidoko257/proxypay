import { syntheticMonitoringService } from "../services/syntheticMonitoringService";

/**
 * Job handler for running synthetic transaction tests for critical flows.
 * Scheduled to run every minute.
 */
export async function runSyntheticMonitoringJob(): Promise<void> {
  console.log("[synthetic-monitoring] Executing synthetic transaction flow checks...");
  const results = await syntheticMonitoringService.runAllFlows();
  const summary = results
    .map((r) => `${r.flow}: ${r.success ? "PASS" : "FAIL"} (${r.durationMs}ms)`)
    .join(" | ");
  console.log(`[synthetic-monitoring] Completed checks: ${summary}`);
}
