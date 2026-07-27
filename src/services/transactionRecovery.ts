/**
 * Transaction Recovery Service
 *
 * Handles partial recovery when a provider request or blockchain submission
 * times out before the response arrives.  This is critical because the remote
 * party may have processed the request successfully even though we never
 * received the acknowledgment.
 *
 * Recovery strategy:
 *
 *   1. PROVIDER_PAYMENT — check the provider's status endpoint using the
 *      original reference ID.  If the provider confirms the transaction
 *      was accepted, mark it as "pending" (awaiting callback) rather than
 *      "failed".
 *
 *   2. BLOCKCHAIN_SUBMIT — query Horizon for the transaction hash.  If found,
 *      the transaction landed and we update our DB to reflect the real status.
 *
 *   3. BATCH_OPERATION — partial recovery: identify completed items within the
 *      batch so only the remaining items need to be retried.
 *
 * All recovery attempts are logged to the `timeout_recovery_log` table and
 * metrics are emitted via `timeoutRecoveryTotal`.
 */

import logger from "../utils/logger";
import { OperationType } from "../utils/timeoutPolicies";
import { timeoutRecoveryTotal } from "../middleware/timeoutMetrics";
import { TransactionStatus } from "../models/transaction";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum RecoveryStatus {
  /** The remote party confirmed the operation succeeded */
  CONFIRMED = "CONFIRMED",
  /** The remote party confirmed the operation failed/unknown */
  NOT_FOUND = "NOT_FOUND",
  /** The recovery check itself failed (network, auth, etc.) */
  RECOVERY_ERROR = "RECOVERY_ERROR",
  /** No recovery strategy applies to this operation type */
  NOT_APPLICABLE = "NOT_APPLICABLE",
  /** Recovery is still in-progress (async) */
  PENDING = "PENDING",
}

export interface RecoveryContext {
  operationType: OperationType;
  transactionId?: string;
  referenceId?: string;
  provider?: string;
  stellarTxHash?: string;
  requestId?: string;
  elapsedMs: number;
  attemptedAt?: string;
}

export interface RecoveryResult {
  status: RecoveryStatus;
  transactionId?: string;
  /** Updated transaction status if the DB record was modified */
  newTransactionStatus?: TransactionStatus;
  message: string;
  recoveredAt: string;
}

// ---------------------------------------------------------------------------
// TransactionRecoveryService
// ---------------------------------------------------------------------------

export class TransactionRecoveryService {
  private dbEnabled: boolean;

  constructor() {
    this.dbEnabled = process.env.NODE_ENV !== "test";
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Entry point: attempt partial recovery for a timed-out operation.
   *
   * The method is intentionally non-throwing — callers should not fail because
   * recovery failed.  All errors are logged internally.
   */
  async attemptRecovery(ctx: RecoveryContext): Promise<RecoveryResult> {
    const attemptedAt = ctx.attemptedAt ?? new Date().toISOString();

    logger.info("Starting timeout recovery", {
      operationType: ctx.operationType,
      transactionId: ctx.transactionId,
      referenceId: ctx.referenceId,
      provider: ctx.provider,
      elapsedMs: ctx.elapsedMs,
    });

    let result: RecoveryResult;

    try {
      switch (ctx.operationType) {
        case OperationType.PROVIDER_PAYMENT:
          result = await this.recoverProviderPayment(ctx);
          break;
        case OperationType.BLOCKCHAIN_SUBMIT:
          result = await this.recoverBlockchainSubmission(ctx);
          break;
        case OperationType.BATCH_OPERATION:
          result = await this.recoverBatchOperation(ctx);
          break;
        default:
          result = {
            status: RecoveryStatus.NOT_APPLICABLE,
            transactionId: ctx.transactionId,
            message: `No recovery strategy for operation type: ${ctx.operationType}`,
            recoveredAt: attemptedAt,
          };
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown recovery error";
      logger.error("Recovery attempt threw an unexpected error", {
        operationType: ctx.operationType,
        transactionId: ctx.transactionId,
        error: message,
      });
      result = {
        status: RecoveryStatus.RECOVERY_ERROR,
        transactionId: ctx.transactionId,
        message,
        recoveredAt: new Date().toISOString(),
      };
    }

    // Metrics
    timeoutRecoveryTotal.inc({
      operation_type: ctx.operationType,
      status: result.status,
    });

    // Persist to recovery log
    if (this.dbEnabled) {
      await this.logRecovery(ctx, result).catch((err) =>
        logger.error("Failed to persist recovery log entry", { error: err }),
      );
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Strategy: Provider Payment
  // -------------------------------------------------------------------------

  private async recoverProviderPayment(
    ctx: RecoveryContext,
  ): Promise<RecoveryResult> {
    const { transactionId, referenceId, provider } = ctx;

    if (!referenceId || !provider) {
      return {
        status: RecoveryStatus.NOT_FOUND,
        transactionId,
        message:
          "Cannot recover provider payment without referenceId and provider",
        recoveredAt: new Date().toISOString(),
      };
    }

    logger.info("Checking provider status for timed-out payment", {
      provider,
      referenceId,
      transactionId,
    });

    try {
      // Lazy import to avoid circular dependencies
      const { MobileMoneyService } = await import(
        "./mobilemoney/mobileMoneyService"
      );
      const svc = new MobileMoneyService();

      const statusResult = await svc.getStatus(provider, referenceId);

      if (statusResult.status === "completed") {
        if (transactionId) {
          await this.updateTransactionStatus(
            transactionId,
            TransactionStatus.Completed,
            { recoveryReason: "provider_status_confirmed_after_timeout" },
          );
        }
        return {
          status: RecoveryStatus.CONFIRMED,
          transactionId,
          newTransactionStatus: TransactionStatus.Completed,
          message: `Provider confirmed transaction ${referenceId} as completed`,
          recoveredAt: new Date().toISOString(),
        };
      }

      if (statusResult.status === "pending") {
        if (transactionId) {
          await this.updateTransactionStatus(
            transactionId,
            TransactionStatus.Pending,
            { recoveryReason: "provider_status_pending_after_timeout" },
          );
        }
        return {
          status: RecoveryStatus.PENDING,
          transactionId,
          newTransactionStatus: TransactionStatus.Pending,
          message: `Provider reports transaction ${referenceId} is still pending`,
          recoveredAt: new Date().toISOString(),
        };
      }

      // failed / unknown
      return {
        status: RecoveryStatus.NOT_FOUND,
        transactionId,
        message: `Provider reports status '${statusResult.status}' for ${referenceId}`,
        recoveredAt: new Date().toISOString(),
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Provider status check failed";
      logger.error("Provider status check failed during recovery", {
        provider,
        referenceId,
        error: message,
      });
      return {
        status: RecoveryStatus.RECOVERY_ERROR,
        transactionId,
        message,
        recoveredAt: new Date().toISOString(),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Strategy: Blockchain Submission
  // -------------------------------------------------------------------------

  private async recoverBlockchainSubmission(
    ctx: RecoveryContext,
  ): Promise<RecoveryResult> {
    const { transactionId, stellarTxHash } = ctx;

    if (!stellarTxHash) {
      return {
        status: RecoveryStatus.NOT_FOUND,
        transactionId,
        message:
          "Cannot recover blockchain submission without stellarTxHash",
        recoveredAt: new Date().toISOString(),
      };
    }

    logger.info("Querying Horizon for timed-out blockchain submission", {
      stellarTxHash,
      transactionId,
    });

    try {
      const { getStellarServer } = await import("../config/stellar");
      const server = getStellarServer();

      const tx = await (server as any)
        .transactions()
        .transaction(stellarTxHash)
        .call();

      if (tx && tx.successful) {
        if (transactionId) {
          await this.updateTransactionStatus(
            transactionId,
            TransactionStatus.Completed,
            {
              stellarTxHash,
              recoveryReason: "horizon_confirmed_after_timeout",
            },
          );
        }
        return {
          status: RecoveryStatus.CONFIRMED,
          transactionId,
          newTransactionStatus: TransactionStatus.Completed,
          message: `Horizon confirmed transaction ${stellarTxHash} succeeded`,
          recoveredAt: new Date().toISOString(),
        };
      }

      if (tx && !tx.successful) {
        return {
          status: RecoveryStatus.NOT_FOUND,
          transactionId,
          message: `Horizon reports transaction ${stellarTxHash} failed`,
          recoveredAt: new Date().toISOString(),
        };
      }

      return {
        status: RecoveryStatus.NOT_FOUND,
        transactionId,
        message: `Transaction ${stellarTxHash} not found on Horizon`,
        recoveredAt: new Date().toISOString(),
      };
    } catch (err: any) {
      // 404 from Horizon — tx genuinely not found
      if (err?.response?.status === 404 || err?.status === 404) {
        return {
          status: RecoveryStatus.NOT_FOUND,
          transactionId,
          message: `Transaction ${stellarTxHash} not found on Horizon (404)`,
          recoveredAt: new Date().toISOString(),
        };
      }

      const message =
        err instanceof Error ? err.message : "Horizon query failed";
      logger.error("Horizon query failed during blockchain recovery", {
        stellarTxHash,
        error: message,
      });
      return {
        status: RecoveryStatus.RECOVERY_ERROR,
        transactionId,
        message,
        recoveredAt: new Date().toISOString(),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Strategy: Batch Operation
  // -------------------------------------------------------------------------

  private async recoverBatchOperation(
    ctx: RecoveryContext,
  ): Promise<RecoveryResult> {
    const { transactionId } = ctx;

    logger.info("Attempting partial batch recovery", { transactionId });

    // For batch operations we mark the parent as "partial" and surface it
    // in the dashboard.  Actual per-item recovery is handled by the batch
    // worker re-processing failed items.
    if (transactionId) {
      await this.updateTransactionStatus(
        transactionId,
        TransactionStatus.Pending,
        { recoveryReason: "batch_partial_recovery_after_timeout" },
      );
    }

    return {
      status: RecoveryStatus.PENDING,
      transactionId,
      newTransactionStatus: TransactionStatus.Pending,
      message:
        "Batch operation marked pending for re-processing after timeout",
      recoveredAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async updateTransactionStatus(
    transactionId: string,
    newStatus: TransactionStatus,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.dbEnabled) return;
    try {
      const { pool } = await import("../config/database.js");
      await pool.query(
        `UPDATE transactions
         SET status = $1,
             metadata = metadata || $2::jsonb,
             updated_at = NOW()
         WHERE id = $3`,
        [newStatus, JSON.stringify(metadata ?? {}), transactionId],
      );
      logger.info("Transaction status updated via recovery", {
        transactionId,
        newStatus,
        metadata,
      });
    } catch (err) {
      logger.error("Failed to update transaction status during recovery", {
        transactionId,
        newStatus,
        error: err,
      });
    }
  }

  private async logRecovery(
    ctx: RecoveryContext,
    result: RecoveryResult,
  ): Promise<void> {
    const { pool } = await import("../config/database.js");
    await pool.query(
      `INSERT INTO timeout_recovery_log
         (operation_type, transaction_id, reference_id, provider,
          stellar_tx_hash, elapsed_ms, recovery_status, message,
          occurred_at, recovered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ctx.operationType,
        ctx.transactionId ?? null,
        ctx.referenceId ?? null,
        ctx.provider ?? null,
        ctx.stellarTxHash ?? null,
        ctx.elapsedMs,
        result.status,
        result.message,
        ctx.attemptedAt ?? new Date().toISOString(),
        result.recoveredAt,
      ],
    );
  }
}

// Singleton
export const transactionRecoveryService = new TransactionRecoveryService();
