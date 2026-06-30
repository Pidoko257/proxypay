import { pool } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { LedgerService, LedgerEntry } from "./ledgerService";
import { notifyTransactionWebhook } from "./webhook";
import { emailService } from "./email";
import logger from "../utils/logger";

/**
 * Chargeback Service
 *
 * Handles incoming chargeback notifications from mobile money operators.
 * Atomically reverses ledger entries, updates transaction status, and
 * notifies the affected organization via webhook and email.
 */

export interface ChargebackNotification {
  chargeback_reference: string;
  transaction_reference: string;
  reason?: string;
  amount?: number;
  currency?: string;
  operator_callback_ref?: string;
  metadata?: Record<string, unknown>;
}

export interface ChargebackResult {
  success: boolean;
  chargebackId: string;
  transactionId: string;
  status: TransactionStatus;
  message: string;
}

export class ChargebackService {
  private transactionModel: TransactionModel;
  private ledgerService: LedgerService;

  constructor(
    transactionModel?: TransactionModel,
    ledgerService?: LedgerService,
  ) {
    this.transactionModel = transactionModel ?? new TransactionModel();
    this.ledgerService = ledgerService ?? new LedgerService();
  }

  async processChargeback(
    notification: ChargebackNotification,
  ): Promise<ChargebackResult> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Step 1: Look up the original transaction
      const transaction = await this.transactionModel.findByReferenceNumber(
        notification.transaction_reference,
      );

      if (!transaction) {
        throw new Error(
          `Transaction not found for reference: ${notification.transaction_reference}`,
        );
      }

      // Step 2: Validate chargeback eligibility
      const eligibleStatuses: TransactionStatus[] = [
        TransactionStatus.Completed,
        TransactionStatus.Pending,
        TransactionStatus.Review,
      ];

      if (!eligibleStatuses.includes(transaction.status)) {
        throw new Error(
          `Transaction ${transaction.id} is in status "${transaction.status}" and is not eligible for chargeback`,
        );
      }

      // Step 3: Reverse original ledger entries
      const originalEntries =
        await this.ledgerService.getEntriesByTransaction(transaction.id);

      if (originalEntries.length > 0) {
        const reversalEntries: LedgerEntry[] = originalEntries.map(
          (entry: any) => ({
            account_code: entry.account_code,
            debit_amount: entry.credit_amount
              ? parseFloat(entry.credit_amount)
              : undefined,
            credit_amount: entry.debit_amount
              ? parseFloat(entry.debit_amount)
              : undefined,
            description: `Chargeback reversal: ${notification.chargeback_reference} - ${notification.reason || "operator chargeback"}`,
            metadata: {
              original_entry_id: entry.id,
              chargeback_reference: notification.chargeback_reference,
            },
          }),
        );

        await this.ledgerService.postTransaction(
          `CHGBK-${notification.chargeback_reference}`,
          `Chargeback: ${notification.chargeback_reference} for transaction ${transaction.referenceNumber}`,
          reversalEntries,
          transaction.id,
          "system-chargeback",
        );
      }

      // Step 4: Update transaction status
      const amount = notification.amount ?? parseFloat(transaction.amount);
      const chargebackRef = notification.chargeback_reference;
      await client.query(
        `UPDATE transactions
         SET status = $1,
             chargeback_reference = $2,
             chargeback_reason = $3,
             chargeback_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [
          TransactionStatus.ChargedBack,
          chargebackRef,
          notification.reason || null,
          transaction.id,
        ],
      );

      // Step 5: Record the chargeback event
      const chargebackInsert = await client.query(
        `INSERT INTO chargebacks
         (transaction_id, chargeback_reference, reason, amount, currency,
          operator_callback_ref, metadata, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
         RETURNING id`,
        [
          transaction.id,
          chargebackRef,
          notification.reason || null,
          amount,
          notification.currency || "USD",
          notification.operator_callback_ref || null,
          JSON.stringify(notification.metadata || {}),
        ],
      );

      const chargebackId = chargebackInsert.rows[0].id;

      await client.query("COMMIT");

      // Step 6: Notify the organization (fire-and-forget)
      this.sendChargebackNotifications(transaction.id, transaction.userId, {
        chargebackId,
        chargebackReference: chargebackRef,
        transactionReference: transaction.referenceNumber,
        reason: notification.reason || "Operator chargeback",
        amount,
        currency: notification.currency || "USD",
      }).catch((err) => {
        logger.error(
          { err, chargebackId, transactionId: transaction.id },
          "[chargeback] Failed to send chargeback notifications",
        );
      });

      logger.info(
        {
          chargebackId,
          transactionId: transaction.id,
          chargebackReference: chargebackRef,
        },
        "[chargeback] Chargeback processed successfully",
      );

      return {
        success: true,
        chargebackId,
        transactionId: transaction.id,
        status: TransactionStatus.ChargedBack,
        message: `Chargeback processed for transaction ${transaction.referenceNumber}`,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error(
        { err: error, transactionRef: notification.transaction_reference },
        "[chargeback] Chargeback processing failed",
      );
      throw error;
    } finally {
      client.release();
    }
  }

  private async sendChargebackNotifications(
    transactionId: string,
    userId: string,
    details: {
      chargebackId: string;
      chargebackReference: string;
      transactionReference: string;
      reason: string;
      amount: number;
      currency: string;
    },
  ): Promise<void> {
    // Send webhook notification with chargeback event
    await notifyTransactionWebhook(transactionId, "transaction.chargeback", {
      transactionModel: this.transactionModel,
    });

    // Send email notification
    if (userId) {
      try {
        const { UserModel } = await import("../models/users.js");
        const userModel = new UserModel();
        const user = await userModel.findById(userId);

        if (user?.email) {
          await emailService.sendEmail({
            to: user.email,
            templateId:
              process.env.SENDGRID_CHARGEBACK_TEMPLATE_ID || "",
            dynamicTemplateData: {
              chargebackReference: details.chargebackReference,
              transactionReference: details.transactionReference,
              reason: details.reason,
              amount: details.amount.toFixed(2),
              currency: details.currency,
              chargebackId: details.chargebackId,
              timestamp: new Date().toISOString(),
              year: new Date().getFullYear(),
            },
          });
        }
      } catch (err) {
        logger.error(
          { err, userId, transactionId },
          "[chargeback] Failed to send chargeback email notification",
        );
      }
    }
  }
}

export const chargebackService = new ChargebackService();
