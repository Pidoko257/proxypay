import { TransactionModel, TransactionStatus } from "../models/transaction";
import { pool } from "../config/database";
import Decimal from "decimal.js";
import logger from "../utils/logger";

export const MIN_WITHDRAWAL_AMOUNT = 1;

export class TransactionService {
  constructor(private txModel: TransactionModel) {}

  async findByUserId(userId: string) {
    return await this.txModel.findByUserId(userId);
  }

  // ============================================================================
  // WITHDRAWAL LOGIC
  // ============================================================================
  async withdraw(payload: {
    userId: string;
    amount: number;
    currency: string;
    provider?: string;
    destinationAccount?: string;
    [key: string]: any;
  }) {
    if (payload.amount < MIN_WITHDRAWAL_AMOUNT) {
      throw new Error("Amount too small");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // ISSUE 1 & 2 FIX: Lock user row inside the transaction to prevent double-spend race conditions
      // This also ensures we read the balance with an exclusive lock that is held until COMMIT
      const user = await client.query(
        `SELECT id, balance FROM users WHERE id = $1 FOR UPDATE`,
        [payload.userId],
      );

      if (user.rows.length === 0) {
        throw new Error("User not found");
      }

      // ISSUE 4 FIX: Convert balance to Decimal for precise financial calculations
      const currentBalance = new Decimal(user.rows[0].balance || "0");

      // ISSUE 2 FIX: Move fee lookup and calculation inside the transaction
      // Lock the fee configuration row with FOR UPDATE to prevent mid-transaction changes
      const feeResult = await this.calculateWithdrawalFeeWithLock(
        client,
        new Decimal(payload.amount),
        payload.currency,
      );

      const fee = feeResult.fee;
      const totalDeduction = feeResult.totalDeduction;

      // Check sufficient balance using Decimal for precision
      if (currentBalance.lessThan(payload.amount)) {
        throw new Error("Insufficient balance");
      }

      if (currentBalance.lessThan(totalDeduction)) {
        throw new Error(
          `Insufficient balance. Required: ${totalDeduction.toString()} (amount: ${payload.amount} + fee: ${fee.toString()}), available: ${currentBalance.toString()}`,
        );
      }

      // Deduct from user balance atomically inside the transaction using Decimal
      const deductionAmount = totalDeduction.toNumber();
      const updateResult = await client.query(
        `UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance`,
        [deductionAmount, payload.userId],
      );

      if (updateResult.rowCount === 0) {
        throw new Error("Insufficient balance");
      }

      // Create withdrawal transaction
      const transaction = await this.txModel.createTransaction({
        userId: payload.userId,
        amount: payload.amount,
        currency: payload.currency,
        type: "WITHDRAWAL",
        status: TransactionStatus.Pending,
        fee: fee.toNumber(),
        metadata: {
          provider: payload.provider || "mtn",
          destination_account: payload.destinationAccount,
          currency: payload.currency,
          fee_breakdown: {
            amount: payload.amount,
            fee: fee.toNumber(),
            total: totalDeduction.toNumber(),
          },
          ...payload,
        },
      });

      // Log to withdrawal ledger
      await client.query(
        `INSERT INTO withdrawal_ledger
          (transaction_id, user_id, amount, fee, currency, provider, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          transaction.id,
          payload.userId,
          payload.amount,
          fee.toNumber(),
          payload.currency,
          payload.provider || "mtn",
          "pending",
        ],
      );

      await client.query("COMMIT");

      return {
        success: true,
        transaction,
        fee: fee.toNumber(),
        totalDeduction: totalDeduction.toNumber(),
        newBalance: currentBalance.minus(totalDeduction).toNumber(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error(
        { error, userId: payload.userId, amount: payload.amount },
        "Withdrawal failed",
      );
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Calculate withdrawal fee inside a transaction with row locking
   * ISSUE 2 FIX: Acquire exclusive lock on fee config to ensure consistency
   * ISSUE 4 FIX: Use Decimal for precise financial arithmetic
   */
  private async calculateWithdrawalFeeWithLock(
    client: any,
    amount: Decimal,
    currency: string,
  ): Promise<{ fee: Decimal; totalDeduction: Decimal }> {
    const result = await client.query(
      `SELECT fee_fixed, fee_percent FROM fee_configurations
       WHERE type = 'withdrawal' AND (currency = $1 OR currency = 'ALL')
       ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [currency],
    );

    let fee: Decimal;

    if (result.rows.length === 0) {
      // Default fee: 1% with $0.50 minimum, using Decimal
      fee = Decimal.max(new Decimal("0.5"), amount.times(new Decimal("0.01")));
    } else {
      const config = result.rows[0];
      const fixedFee = new Decimal(config.fee_fixed || "0");
      const percentFee = amount.times(new Decimal(config.fee_percent || "0.01"));

      fee = Decimal.max(fixedFee, percentFee);
    }

    // Round to 2 decimal places (cents)
    fee = fee.toDecimalPlaces(2);
    const totalDeduction = amount.plus(fee);

    return { fee, totalDeduction };
  }
}