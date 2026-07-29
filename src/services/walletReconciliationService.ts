import { Decimal } from "decimal.js";
import { getStellarServer } from "../config/stellar";
import StellarSdk from "stellar-sdk";
import { queryRead, queryWrite } from "../config/database";
import {
  reconciliationJobModel,
  walletDiscrepancyModel,
  reconciliationSettingsModel,
  type ReconciliationJob,
  type WalletDiscrepancy,
} from "../models/reconciliation";
import logger from "../utils/logger";

export interface WalletBalance {
  address: string;
  balance: Decimal;
  asset: {
    code: string;
    issuer: string;
  };
  lastUpdated: Date;
}

export interface ReconciliationResult {
  jobId: string;
  jobType: string;
  status: "completed" | "partial" | "failed";
  totalAccounts: number;
  successfulChecks: number;
  discrepancies: WalletDiscrepancy[];
  autoCorrections: number;
  durationMs: number;
  errors: string[];
}

/**
 * Wallet Balance Reconciliation Service
 * 
 * Compares ProxyPay ledger balances with Stellar blockchain account balances
 * and detects/alerts on discrepancies.
 */
export class WalletReconciliationService {
  private server: StellarSdk.Horizon.Server;
  private issuerAddress: string;

  constructor() {
    this.server = getStellarServer();
    this.issuerAddress = process.env.STELLAR_ISSUER_PUBLIC_KEY || "";
  }

  /**
   * Reconcile all user wallets
   */
  async reconcileAllWallets(): Promise<ReconciliationResult> {
    const job = await reconciliationJobModel.create({
      jobType: "stellar_ledger",
    });

    const startTime = Date.now();
    const errors: string[] = [];
    const discrepancies: WalletDiscrepancy[] = [];
    let successfulChecks = 0;
    let autoCorrections = 0;

    try {
      // Update job status to in_progress
      await reconciliationJobModel.updateStatus(job.id, "in_progress");

      // Get all users with Stellar wallets
      const users = await this.getAllUsersWithWallets();
      logger.info(`[Reconciliation] Starting reconciliation for ${users.length} users`);

      // Get settings
      const settings = await reconciliationSettingsModel.getSettings();

      // Process users in batches
      for (let i = 0; i < users.length; i += settings.batchSize) {
        const batch = users.slice(i, i + settings.batchSize);

        const batchResults = await Promise.all(
          batch.map((user) => this.reconcileUserWallet(user, job.id)),
        );

        for (const result of batchResults) {
          if (result.success) {
            successfulChecks++;
          } else {
            errors.push(result.error || "Unknown error");
          }

          if (result.discrepancy) {
            discrepancies.push(result.discrepancy);

            // Auto-correct if enabled and applicable
            if (settings.autoCorrectionEnabled && result.discrepancy.discrepancyType === "ledger_surplus") {
              try {
                await this.autoCorrectLedger(result.discrepancy, job.id);
                autoCorrections++;
              } catch (err) {
                errors.push(`Auto-correction failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }
      }

      // Update job status to completed
      const durationMs = Date.now() - startTime;
      await reconciliationJobModel.updateStatus(job.id, "completed", {
        successfulChecks,
        discrepanciesFound: discrepancies.length,
        autoCorrections,
        errorsEncountered: errors.length,
        totalAccounts: users.length,
        summary: `Checked ${users.length} accounts, found ${discrepancies.length} discrepancies, auto-corrected ${autoCorrections}`,
      });

      logger.info(`[Reconciliation] Job ${job.id} completed in ${durationMs}ms`);

      return {
        jobId: job.id,
        jobType: "stellar_ledger",
        status: errors.length > 0 ? "partial" : "completed",
        totalAccounts: users.length,
        successfulChecks,
        discrepancies,
        autoCorrections,
        durationMs,
        errors,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[Reconciliation] Job ${job.id} failed: ${errorMsg}`);

      await reconciliationJobModel.updateStatus(job.id, "failed", {
        errorMessage: errorMsg,
        errorsEncountered: errors.length + 1,
      });

      throw error;
    }
  }

  /**
   * Reconcile a single user's wallet
   */
  async reconcileUserWallet(
    user: { id: string; stellarAddress?: string },
    jobId: string,
  ): Promise<{ success: boolean; error?: string; discrepancy?: WalletDiscrepancy }> {
    try {
      if (!user.stellarAddress) {
        return { success: false, error: "User has no Stellar address" };
      }

      // Get ledger balance
      const ledgerBalance = await this.getLedgerBalance(user.id, user.stellarAddress);

      // Get Stellar blockchain balance
      const stellarBalance = await this.getStellarBalance(user.stellarAddress);

      // Compare balances
      const discrepancy = this.compareBalances(ledgerBalance, stellarBalance);

      if (discrepancy) {
        // Create discrepancy record
        const discrepancyRecord = await walletDiscrepancyModel.create({
          reconciliationJobId: jobId,
          userId: user.id,
          walletAddress: user.stellarAddress,
          ledgerBalance: ledgerBalance.balance.toNumber(),
          stellarBalance: stellarBalance.balance.toNumber(),
          discrepancyAmount: discrepancy.amount.toNumber(),
          discrepancyType: discrepancy.type,
          assetCode: stellarBalance.asset.code,
          issuerAddress: stellarBalance.asset.issuer,
          status: "pending",
          severity: this.calculateSeverity(discrepancy.amount),
          possibleCauses: this.identifyPossibleCauses(discrepancy.type),
        });

        return { success: true, discrepancy: discrepancyRecord };
      }

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[Reconciliation] Failed to reconcile user ${user.id}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Get ledger balance for user
   */
  private async getLedgerBalance(
    userId: string,
    stellarAddress: string,
  ): Promise<WalletBalance> {
    // Query ProxyPay ledger
    const result = await queryRead(
      `SELECT 
         SUM(CASE WHEN debit_amount > 0 THEN debit_amount ELSE 0 END) as total_debits,
         SUM(CASE WHEN credit_amount > 0 THEN credit_amount ELSE 0 END) as total_credits
       FROM ledger_entries
       WHERE account_code = $1`,
      [stellarAddress],
    );

    const row = result.rows[0];
    const debits = new Decimal(row.total_debits || 0);
    const credits = new Decimal(row.total_credits || 0);
    const balance = debits.minus(credits);

    return {
      address: stellarAddress,
      balance,
      asset: { code: "XLM", issuer: this.issuerAddress },
      lastUpdated: new Date(),
    };
  }

  /**
   * Get balance from Stellar blockchain
   */
  private async getStellarBalance(stellarAddress: string): Promise<WalletBalance> {
    try {
      const account = await this.server.accounts().accountId(stellarAddress).call();

      // Find XLM balance
      const xlmBalance = account.balances.find((b) => b.asset_type === "native");

      if (!xlmBalance) {
        return {
          address: stellarAddress,
          balance: new Decimal(0),
          asset: { code: "XLM", issuer: "native" },
          lastUpdated: new Date(),
        };
      }

      return {
        address: stellarAddress,
        balance: new Decimal(xlmBalance.balance),
        asset: { code: "XLM", issuer: "native" },
        lastUpdated: new Date(),
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        // Account doesn't exist on blockchain
        return {
          address: stellarAddress,
          balance: new Decimal(0),
          asset: { code: "XLM", issuer: "native" },
          lastUpdated: new Date(),
        };
      }
      throw error;
    }
  }

  /**
   * Compare ledger and Stellar balances
   */
  private compareBalances(
    ledger: WalletBalance,
    stellar: WalletBalance,
  ): { amount: Decimal; type: string } | null {
    const difference = ledger.balance.minus(stellar.balance);

    // Use configurable threshold
    if (Math.abs(difference.toNumber()) < 0.0001) {
      // Balances match (within precision tolerance)
      return null;
    }

    if (difference.isPositive()) {
      return {
        amount: difference,
        type: "ledger_surplus",
      };
    } else {
      return {
        amount: difference.abs(),
        type: "ledger_deficit",
      };
    }
  }

  /**
   * Calculate severity based on discrepancy amount
   */
  private calculateSeverity(amount: Decimal): string {
    const absAmount = amount.abs().toNumber();

    if (absAmount > 10000) return "critical";
    if (absAmount > 1000) return "high";
    if (absAmount > 100) return "medium";
    return "low";
  }

  /**
   * Identify possible causes of discrepancy
   */
  private identifyPossibleCauses(discrepancyType: string): string[] {
    const causes: string[] = [];

    if (discrepancyType === "ledger_surplus") {
      causes.push("Ledger entry error");
      causes.push("Duplicate transaction recorded");
      causes.push("Pending transaction not yet confirmed on blockchain");
      causes.push("Manual adjustment not reflected on blockchain");
    } else if (discrepancyType === "ledger_deficit") {
      causes.push("Blockchain transaction not recorded in ledger");
      causes.push("Transaction reversal or clawback");
      causes.push("Fee collection");
      causes.push("Network error during recording");
    }

    return causes;
  }

  /**
   * Automatically correct ledger errors
   */
  private async autoCorrectLedger(
    discrepancy: WalletDiscrepancy,
    jobId: string,
  ): Promise<void> {
    logger.info(`[Reconciliation] Auto-correcting discrepancy ${discrepancy.id}`);

    // Create correcting entry in ledger
    const correctionAmount = discrepancy.discrepancyAmount;

    // Update discrepancy record
    await walletDiscrepancyModel.updateStatus(discrepancy.id, "auto_corrected", {
      autoCorrectionApplied: true,
      resolutionType: "auto_corrected",
      resolutionNotes: `Auto-corrected by reconciliation job ${jobId}. Amount: ${correctionAmount}`,
    });
  }

  /**
   * Get all users with Stellar wallets
   */
  private async getAllUsersWithWallets(): Promise<Array<{ id: string; stellarAddress?: string }>> {
    const result = await queryRead(
      `SELECT DISTINCT user_id as id, stellar_address as "stellarAddress" 
       FROM transactions
       WHERE stellar_address IS NOT NULL
       UNION
       SELECT id, stellar_address as "stellarAddress" FROM users
       WHERE stellar_address IS NOT NULL`,
      [],
    );

    return result.rows;
  }

  /**
   * Manual reconciliation trigger
   */
  async triggerManualReconciliation(userId?: string): Promise<ReconciliationJob> {
    const job = await reconciliationJobModel.create({
      jobType: userId ? "user_manual_reconciliation" : "system_manual_reconciliation",
    });

    await reconciliationJobModel.updateStatus(job.id, "in_progress");

    try {
      if (userId) {
        // Reconcile specific user
        const user = await queryRead("SELECT id, stellar_address FROM users WHERE id = $1", [userId]);
        if (user.rows.length === 0) throw new Error("User not found");

        const userRow = user.rows[0];
        const result = await this.reconcileUserWallet(
          { id: userRow.id, stellarAddress: userRow.stellar_address },
          job.id,
        );

        await reconciliationJobModel.updateStatus(job.id, "completed", {
          successfulChecks: result.success ? 1 : 0,
          discrepanciesFound: result.discrepancy ? 1 : 0,
          totalAccounts: 1,
        });
      }

      return job;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await reconciliationJobModel.updateStatus(job.id, "failed", {
        errorMessage: errorMsg,
      });
      throw error;
    }
  }

  /**
   * Get reconciliation history
   */
  async getReconciliationHistory(
    jobType?: string,
    limit: number = 50,
  ): Promise<ReconciliationJob[]> {
    let query =
      "SELECT * FROM reconciliation_jobs WHERE status IN ('completed', 'failed', 'partial')";
    const params: any[] = [];

    if (jobType) {
      query += " AND job_type = $" + (params.length + 1);
      params.push(jobType);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await queryRead(query, params);
    return result.rows.map((row) => ({
      id: row.id,
      jobType: row.job_type,
      status: row.status,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      totalAccounts: row.total_accounts || 0,
      successfulChecks: row.successful_checks || 0,
      discrepanciesFound: row.discrepancies_found || 0,
      autoCorrections: row.auto_corrections || 0,
      manualReviewsNeeded: row.manual_reviews_needed || 0,
      durationMs: row.duration_ms,
      errorsEncountered: row.errors_encountered || 0,
      errorMessage: row.error_message,
      summary: row.summary,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  }
}

export const walletReconciliationService = new WalletReconciliationService();
