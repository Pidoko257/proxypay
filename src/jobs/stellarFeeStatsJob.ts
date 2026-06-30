import { updateFeeStatsCache } from "../services/stellarFeeStatsCache";

export async function runStellarFeeStatsJob(): Promise<void> {
  console.log("[stellar-fee-stats] Refreshing fee stats from Horizon");
  try {
    await updateFeeStatsCache();
    console.log("[stellar-fee-stats] Refresh complete");
  } catch (err) {
    console.error("[stellar-fee-stats] Job failed", err);
  }
}
