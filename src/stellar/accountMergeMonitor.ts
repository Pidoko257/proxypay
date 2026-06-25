/**
 * Horizon Stream Listener — Account Merge Monitor
 *
 * Streams operations for every active ProxyPay Stellar account.
 * When an `account_merge` operation is detected:
 *   1. All pending/review transactions for that account are flagged to `review`
 *   2. The user account is frozen to prevent future use
 *   3. An alert is sent to the configured ops alert email
 */
import * as StellarSdk from "stellar-sdk";
import { Pool } from "pg";
import { TransactionStatus } from "../models/transaction";
import { emailService } from "../services/email";
import logger from "../utils/logger";

export interface AccountMergeMonitor {
  start(): Promise<void>;
  stop(): void;
}

// Statuses that should be flagged for review when an account merge is detected
const FLAGGABLE_STATUSES = [
  TransactionStatus.Pending,
  TransactionStatus.Review,
].join("','");

export function createAccountMergeMonitor(
  db: Pool,
  server: StellarSdk.Horizon.Server,
): AccountMergeMonitor {
  const stopFns: Array<() => void> = [];
  let stopped = false;

  async function handleMerge(mergedAccount: string): Promise<void> {
    logger.warn({ account: mergedAccount }, "[account-merge-monitor] account_merge detected");

    // 1. Flag all active transactions to review via user_id join
    //    (stellar_address on transactions is encrypted; join through users avoids decryption)
    const txResult2 = await db.query(
      `UPDATE transactions t
          SET status = $1, updated_at = NOW()
         FROM users u
        WHERE u.stellar_address = $2
          AND t.user_id = u.id
          AND t.status IN ('${FLAGGABLE_STATUSES}')
       RETURNING t.id`,
      [TransactionStatus.Review, mergedAccount],
    );

    const flaggedCount = txResult2.rowCount ?? 0;

    // 2. Freeze the user account and record the merge
    await db.query(
      `UPDATE users
          SET status = 'frozen',
              stellar_address = NULL,
              updated_at = NOW()
        WHERE stellar_address = $1`,
      [mergedAccount],
    );

    // Record the merged account to prevent re-use
    await db.query(
      `INSERT INTO merged_stellar_accounts (stellar_address, detected_at)
       VALUES ($1, NOW())
       ON CONFLICT (stellar_address) DO NOTHING`,
      [mergedAccount],
    );

    logger.warn(
      { account: mergedAccount, flaggedTransactions: flaggedCount },
      "[account-merge-monitor] user frozen and transactions flagged",
    );

    // 3. Send ops alert
    const opsEmail = process.env.OPS_ALERT_EMAIL;
    if (opsEmail) {
      await emailService
        .sendEmail({
          to: opsEmail,
          templateId: process.env.SENDGRID_OPS_ALERT_TEMPLATE_ID || "",
          dynamicTemplateData: {
            subject: `[ALERT] Stellar account_merge detected: ${mergedAccount}`,
            alert_type: "account_merge",
            merged_account: mergedAccount,
            flagged_transactions: flaggedCount,
            detected_at: new Date().toISOString(),
            message: `Stellar account ${mergedAccount} was merged into another account. `
              + `${flaggedCount} transaction(s) have been flagged for manual review. `
              + `The user account has been frozen.`,
          },
        })
        .catch((err) =>
          logger.error({ err }, "[account-merge-monitor] failed to send ops alert"),
        );
    } else {
      logger.warn("[account-merge-monitor] OPS_ALERT_EMAIL not configured — skipping email alert");
    }
  }

  function streamAccount(stellarAddress: string): void {
    if (stopped) return;

    let stopStream: (() => void) | null = null;

    const connect = () => {
      if (stopped) return;

      stopStream = server
        .operations()
        .forAccount(stellarAddress)
        .cursor("now")
        .stream({
          onmessage: async (op: StellarSdk.Horizon.ServerApi.OperationRecord) => {
            if (op.type === "account_merge") {
              const mergeOp = op as StellarSdk.Horizon.ServerApi.AccountMergeOperationRecord;
              // `mergeOp.account` is the account being merged away
              const mergedAccount = (mergeOp as any).source_account ?? stellarAddress;
              await handleMerge(mergedAccount).catch((err) =>
                logger.error({ err, account: stellarAddress }, "[account-merge-monitor] handleMerge failed"),
              );
            }
          },
          onerror: (err: Error) => {
            logger.warn({ err: err.message, account: stellarAddress }, "[account-merge-monitor] stream error, reconnecting in 5s");
            stopStream?.();
            if (!stopped) setTimeout(connect, 5_000);
          },
        });

      stopFns.push(() => stopStream?.());
    };

    connect();
  }

  return {
    async start(): Promise<void> {
      const result = await db.query(
        `SELECT stellar_address FROM users
          WHERE stellar_address IS NOT NULL
            AND status = 'active'`,
      );

      if (result.rows.length === 0) {
        logger.info("[account-merge-monitor] no active monitored accounts");
        return;
      }

      logger.info(
        { count: result.rows.length },
        "[account-merge-monitor] starting stream listeners",
      );

      for (const row of result.rows) {
        streamAccount(row.stellar_address as string);
      }
    },

    stop(): void {
      stopped = true;
      for (const fn of stopFns) fn();
      stopFns.length = 0;
    },
  };
}
