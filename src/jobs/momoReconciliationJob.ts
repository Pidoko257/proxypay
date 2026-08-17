import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import logger from "../utils/logger";

const THRESHOLD_MINUTES = 10;

export interface ReconciliationSummary {
  checked: number;
  updated: number;
  flagged: number;
  errors: number;
}

/**
 * MoMo Reconciliation Job
 *
 * Fetches transactions in a non-terminal state (pending) that are older than
 * THRESHOLD_MINUTES, queries the MoMo provider for their actual status, and
 * reconciles local records accordingly.
 *
 * Discrepancy: MoMo reports "completed" but local status is "failed" →
 * flagged for manual review (status set to "review").
 */
export async function runMomoReconciliationJob(
  service?: InstanceType<typeof MobileMoneyService>,
): Promise<ReconciliationSummary> {
  logger.info("[momo-reconciliation] Starting reconciliation run");

  const result = await pool.query<{
    id: string;
    reference_number: string;
    provider: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, reference_number, provider, status, created_at
     FROM transactions
     WHERE status = $1
       AND created_at < NOW() - INTERVAL '${THRESHOLD_MINUTES} minutes'
     ORDER BY created_at ASC`,
    [TransactionStatus.Pending],
  );

  const rows = result.rows;

  if (rows.length === 0) {
    logger.info("[momo-reconciliation] No transactions require reconciliation");
    return { checked: 0, updated: 0, flagged: 0, errors: 0 };
  }

  logger.info(
    { count: rows.length, thresholdMinutes: THRESHOLD_MINUTES },
    "[momo-reconciliation] Transactions to reconcile",
  );

  const transactionModel = new TransactionModel();
  const mobileMoneyService = service ?? new MobileMoneyService();

  let updated = 0;
  let flagged = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const { data, success } = await mobileMoneyService.getTransactionStatus(
        row.provider as any,
        row.reference_number,
      );

      if (!success || !data) {
        logger.warn(
          { transactionId: row.id, provider: row.provider },
          "[momo-reconciliation] Provider status check failed — skipping",
        );
        errors++;
        continue;
      }

      const providerStatus: string = data.status;

      if (providerStatus === "completed" || providerStatus === "successful") {
        if (row.status === TransactionStatus.Failed) {
          // Discrepancy: MoMo succeeded but we marked it failed → flag for review
          await transactionModel.updateStatus(row.id, TransactionStatus.Review);
          logger.warn(
            { transactionId: row.id, reference: row.reference_number, provider: row.provider },
            "[momo-reconciliation] DISCREPANCY — MoMo completed but local was failed; flagged for review",
          );
          flagged++;
        } else {
          await transactionModel.updateStatus(row.id, TransactionStatus.Completed);
          logger.info(
            { transactionId: row.id, reference: row.reference_number },
            "[momo-reconciliation] Reconciled → completed",
          );
          updated++;
        }
      } else if (providerStatus === "failed" || providerStatus === "rejected") {
        await transactionModel.updateStatus(row.id, TransactionStatus.Failed);
        logger.info(
          { transactionId: row.id, reference: row.reference_number },
          "[momo-reconciliation] Reconciled → failed",
        );
        updated++;
      } else {
        // Still pending / unknown at provider — leave for next run
        logger.info(
          { transactionId: row.id, providerStatus },
          "[momo-reconciliation] Provider still pending — deferred",
        );
      }
    } catch (err) {
      logger.error(
        { error: err, transactionId: row.id },
        "[momo-reconciliation] Error processing transaction",
      );
      errors++;
    }
  }

  logger.info(
    { checked: rows.length, updated, flagged, errors },
    "[momo-reconciliation] Reconciliation run completed",
  );

  return { checked: rows.length, updated, flagged, errors };
}
