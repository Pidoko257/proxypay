import { queryBaselineService } from "../services/queryBaselineService";

export async function runQueryBaselineJob(): Promise<void> {
  console.info("[query-baseline-job] Starting query performance baseline tracking sync");
  try {
    await queryBaselineService.loadBaselines();
    const baselines = await queryBaselineService.getAllBaselines();
    console.info(
      `[query-baseline-job] Successfully synced performance baselines for ${baselines.length} monitored queries`,
    );
  } catch (error: any) {
    console.error("[query-baseline-job] Failed to execute baseline sync:", error?.message || error);
  }
}
