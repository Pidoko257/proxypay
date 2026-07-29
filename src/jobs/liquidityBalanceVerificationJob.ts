import * as StellarSdk from "stellar-sdk";
import { getStellarServer } from "../config/stellar";
import { pool } from "../config/database";
import { env } from "../config/env";
import { notifySlackAlert } from "../services/loggers";
import { createPagerDutyService } from "../services/pagerDutyService";

export interface VaultProviderBalance {
  provider: string;
  vaultId: string;
  vaultName: string;
  dbBalanceXlm: number;
  onChainBalanceXlm: number;
  discrepancyXlm: number;
  hasMismatch: boolean;
}

export interface LiquidityReconciliationReport {
  timestamp: string;
  totalVaultsChecked: number;
  mismatchCount: number;
  thresholdXlm: number;
  items: VaultProviderBalance[];
}

/**
 * Fetch list of active vaults with their provider configurations and DB balances
 */
async function getActiveVaultBalances(): Promise<Array<{ id: string; name: string; provider: string; publicKey: string; dbBalance: number }>> {
  const query = `
    SELECT 
      v.id, 
      v.name, 
      COALESCE(v.provider, 'stellar') AS provider, 
      COALESCE(v.public_key, process.env.STELLAR_ISSUER_PUBLIC_KEY, '') AS public_key,
      COALESCE(v.balance, 0)::numeric AS db_balance
    FROM vaults v
    WHERE v.is_active = true;
  `;
  try {
    const result = await pool.query(query);
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      publicKey: row.public_key,
      dbBalance: parseFloat(row.db_balance || "0"),
    }));
  } catch (err) {
    // Fallback if vaults table structure is basic
    const fallbackQuery = `SELECT id, name, balance::numeric FROM vaults WHERE is_active = true`;
    const fallbackResult = await pool.query(fallbackQuery);
    return fallbackResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: "stellar",
      publicKey: process.env.HOT_WALLET_PUBLIC_KEYS?.split(",")[0]?.trim() || "",
      dbBalance: parseFloat(row.balance || "0"),
    }));
  }
}

/**
 * Query Stellar Horizon on-chain native XLM balance for a given public key / vault
 */
async function getOnChainXlmBalance(publicKey: string): Promise<number> {
  if (!publicKey || publicKey.trim().length === 0) {
    return 0;
  }
  const server = getStellarServer();
  try {
    const account = await server.loadAccount(publicKey);
    const nativeBalance = account.balances.find((b) => b.asset_type === "native");
    return nativeBalance ? parseFloat(nativeBalance.balance) : 0;
  } catch (error: any) {
    console.error(`[lp-balance-verification] Failed to fetch Stellar on-chain account ${publicKey}:`, error?.message || error);
    return 0;
  }
}

/**
 * Nightly Liquidity Pool & Vault Balance Verification Job
 * Verifies vault balances on-chain vs in-database for each provider and alerts on discrepancies > 0.01 XLM.
 */
export async function runLiquidityPoolBalanceVerificationJob(): Promise<LiquidityReconciliationReport> {
  console.info("[lp-balance-verification] Starting nightly liquidity pool balance verification job");
  const threshold = env.LP_BALANCE_MISMATCH_THRESHOLD || 0.01;
  const vaultItems = await getActiveVaultBalances();
  const reportItems: VaultProviderBalance[] = [];
  let mismatchCount = 0;

  for (const vault of vaultItems) {
    const onChainBalance = await getOnChainXlmBalance(vault.publicKey);
    const discrepancy = Math.abs(vault.dbBalance - onChainBalance);
    const hasMismatch = discrepancy > threshold;

    if (hasMismatch) {
      mismatchCount++;
      const alertMessage = `[LIQUIDITY POOL BALANCE MISMATCH] Discrepancy detected for Vault "${vault.name}" (ID: ${vault.id}, Provider: ${vault.provider}). DB Balance: ${vault.dbBalance} XLM, On-Chain Balance: ${onChainBalance} XLM, Discrepancy: ${discrepancy.toFixed(4)} XLM (Threshold: ${threshold} XLM)`;
      console.warn(alertMessage);
      notifySlackAlert(alertMessage);

      // Trigger PagerDuty Alert if available
      try {
        const pagerDuty = createPagerDutyService();
        await pagerDuty.triggerIncident({
          summary: alertMessage,
          severity: "error",
          source: "liquidity-balance-verification-job",
          customDetails: {
            vaultId: vault.id,
            vaultName: vault.name,
            provider: vault.provider,
            dbBalance: vault.dbBalance,
            onChainBalance,
            discrepancy,
            threshold,
          },
        });
      } catch (pdErr) {
        console.error("[lp-balance-verification] Failed to send PagerDuty alert:", pdErr);
      }
    }

    reportItems.push({
      provider: vault.provider,
      vaultId: vault.id,
      vaultName: vault.name,
      dbBalanceXlm: vault.dbBalance,
      onChainBalanceXlm: onChainBalance,
      discrepancyXlm: discrepancy,
      hasMismatch,
    });
  }

  const report: LiquidityReconciliationReport = {
    timestamp: new Date().toISOString(),
    totalVaultsChecked: vaultItems.length,
    mismatchCount,
    thresholdXlm: threshold,
    items: reportItems,
  };

  console.info(
    `[lp-balance-verification] Nightly liquidity pool balance verification complete. Checked ${report.totalVaultsChecked} vaults, found ${mismatchCount} discrepancies > ${threshold} XLM.`,
  );

  return report;
}
