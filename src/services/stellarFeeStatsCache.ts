import { redisClient } from "../config/redis";
import { getStellarServer } from "../config/stellar";

export const FEE_STATS_CACHE_KEY = "stellar:fee_stats";
export const FEE_STATS_TTL = 30;

export interface FeeStats {
  lastLedgerBaseFee: number;
  lastLedger: string;
  fetchedAt: string;
}

export async function getCachedBaseFee(): Promise<number | null> {
  if (!redisClient?.isOpen) return null;

  try {
    const raw = await redisClient.get(FEE_STATS_CACHE_KEY);
    if (!raw) return null;

    const stats: FeeStats = JSON.parse(raw);
    return stats.lastLedgerBaseFee;
  } catch (err) {
    console.warn("[stellar-fee-stats] Cache read failed", err);
    return null;
  }
}

export async function fetchFeeStatsFromHorizon(): Promise<FeeStats> {
  const server = getStellarServer();
  const stats = await server.feeStats();
  return {
    lastLedgerBaseFee: Number(stats.last_ledger_base_fee),
    lastLedger: stats.last_ledger,
    fetchedAt: new Date().toISOString(),
  };
}

export async function updateFeeStatsCache(): Promise<void> {
  if (!redisClient?.isOpen) {
    console.warn(
      "[stellar-fee-stats] Redis not available, skipping cache update",
    );
    return;
  }

  try {
    const stats = await fetchFeeStatsFromHorizon();
    await redisClient.setEx(
      FEE_STATS_CACHE_KEY,
      FEE_STATS_TTL,
      JSON.stringify(stats),
    );
    console.log(
      `[stellar-fee-stats] Updated cache: baseFee=${stats.lastLedgerBaseFee}, ledger=${stats.lastLedger}`,
    );
  } catch (err) {
    console.error(
      "[stellar-fee-stats] Failed to fetch fee stats from Horizon",
      err,
    );
  }
}
