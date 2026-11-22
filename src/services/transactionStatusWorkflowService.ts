import logger from "../utils/logger";
import { pool } from "../config/database";
import { TransactionStatus } from "../models/transaction";

export type DetailedStatus =
  | "INITIATED"
  | "KYC_VERIFYING"
  | "AML_CHECKING"
  | "FUNDS_RESERVED"
  | "SUBMITTED_TO_PROVIDER"
  | "PROVIDER_PROCESSING"
  | "AWAITING_CONFIRMATION"
  | "COMPLETED"
  | "FAILED"
  | "REVERSED"
  | "REFUNDED"
  | "FLAGGED_FOR_REVIEW";

export interface StatusHistoryEntry {
  fromStatus?: DetailedStatus | TransactionStatus;
  toStatus: DetailedStatus | TransactionStatus;
  reason?: string;
  explanation: string;
  updatedBy: string;
  timestamp: Date;
}

export class TransactionStatusWorkflowService {
  private static readonly VALID_TRANSITIONS: Record<DetailedStatus, DetailedStatus[]> = {
    INITIATED: ["KYC_VERIFYING", "AML_CHECKING", "FLAGGED_FOR_REVIEW", "FAILED"],
    KYC_VERIFYING: ["AML_CHECKING", "FLAGGED_FOR_REVIEW", "FAILED"],
    AML_CHECKING: ["FUNDS_RESERVED", "FLAGGED_FOR_REVIEW", "FAILED"],
    FUNDS_RESERVED: ["SUBMITTED_TO_PROVIDER", "FAILED"],
    SUBMITTED_TO_PROVIDER: ["PROVIDER_PROCESSING", "FAILED"],
    PROVIDER_PROCESSING: ["AWAITING_CONFIRMATION", "COMPLETED", "FAILED"],
    AWAITING_CONFIRMATION: ["COMPLETED", "FAILED"],
    COMPLETED: ["REVERSED", "REFUNDED"],
    FAILED: [],
    REVERSED: [],
    REFUNDED: [],
    FLAGGED_FOR_REVIEW: ["INITIATED", "FUNDS_RESERVED", "FAILED"],
  };

  private static readonly VALID_BASE_TRANSITIONS: Record<TransactionStatus, TransactionStatus[]> = {
    [TransactionStatus.Pending]: [
      TransactionStatus.Completed,
      TransactionStatus.Failed,
      TransactionStatus.Cancelled,
      TransactionStatus.Review,
    ],
    [TransactionStatus.Review]: [
      TransactionStatus.Pending,
      TransactionStatus.Completed,
      TransactionStatus.Failed,
      TransactionStatus.Cancelled,
    ],
    [TransactionStatus.Completed]: [
      TransactionStatus.Dispute,
      TransactionStatus.Reversed,
      TransactionStatus.ClawedBack,
    ],
    [TransactionStatus.Dispute]: [
      TransactionStatus.Completed,
      TransactionStatus.Reversed,
      TransactionStatus.Failed,
    ],
    [TransactionStatus.Failed]: [],
    [TransactionStatus.Cancelled]: [],
    [TransactionStatus.Reversed]: [],
    [TransactionStatus.ClawedBack]: [],
  };

  private static readonly EXPLANATIONS: Record<DetailedStatus, string> = {
    INITIATED: "Transaction initiated by user or merchant.",
    KYC_VERIFYING: "Identity verification is actively being verified.",
    AML_CHECKING: "Anti-Money Laundering screening and sanction checks in progress.",
    FUNDS_RESERVED: "Customer funds have been secured and locked for processing.",
    SUBMITTED_TO_PROVIDER: "Transfer payload sent to external banking or Stellar network gateway.",
    PROVIDER_PROCESSING: "External network provider is clearing the transaction.",
    AWAITING_CONFIRMATION: "Transaction executed; waiting for blockchain ledger or clearing house finality.",
    COMPLETED: "Transaction successfully settled and confirmed.",
    FAILED: "Transaction terminated due to an error, timeout, or policy rejection.",
    REVERSED: "Transaction settlement has been rolled back and reversed.",
    REFUNDED: "Funds returned to original funding account.",
    FLAGGED_FOR_REVIEW: "High-risk signals detected; transaction placed in manual review queue.",
  };

  /**
   * Validate if a transition between two detailed statuses is allowed.
   */
  public isValidTransition(current: DetailedStatus, next: DetailedStatus): boolean {
    const allowed = TransactionStatusWorkflowService.VALID_TRANSITIONS[current] || [];
    return allowed.includes(next);
  }

  /**
   * Validate if a transition between two base TransactionStatuses is allowed.
   * Prevents scattered updates across handlers, workers, callbacks, and reconciliation from bypassing allowed transitions.
   */
  public isValidBaseTransition(current: TransactionStatus, next: TransactionStatus): boolean {
    if (current === next) return true;
    const allowed = TransactionStatusWorkflowService.VALID_BASE_TRANSITIONS[current] || [];
    return allowed.includes(next);
  }

  /**
   * Enforce allowed base status transitions, throwing an error if invalid.
   */
  public validateBaseTransition(txId: string, current: TransactionStatus, next: TransactionStatus): void {
    if (!this.isValidBaseTransition(current, next)) {
      const msg = `Invalid transaction status transition from ${current} to ${next} for transaction ${txId}`;
      logger.error(`[StatusWorkflow] ${msg}`);
      throw new Error(msg);
    }
  }

  /**
   * Get allowed next base statuses for a given status.
   */
  public getAllowedBaseTransitions(status: TransactionStatus): TransactionStatus[] {
    return [...(TransactionStatusWorkflowService.VALID_BASE_TRANSITIONS[status] || [])];
  }

  /**
   * Transition transaction status, recording detailed history and explanations.
   * History is persisted to `transaction_status_history` so it survives
   * restarts and is shared across all API replicas.
   */
  public async transition(
    txId: string,
    current: DetailedStatus,
    next: DetailedStatus,
    updatedBy: string = "system",
    reason?: string
  ): Promise<StatusHistoryEntry> {
    if (!this.isValidTransition(current, next)) {
      const msg = `Invalid state transition from ${current} to ${next} for transaction ${txId}`;
      logger.error(`[StatusWorkflow] ${msg}`);
      throw new Error(msg);
    }

    const explanation = TransactionStatusWorkflowService.EXPLANATIONS[next];

    const { rows } = await pool.query<{ created_at: Date }>(
      `INSERT INTO transaction_status_history
         (transaction_id, from_status, to_status, reason, explanation, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING created_at`,
      [txId, current, next, reason ?? null, explanation, updatedBy],
    );

    const entry: StatusHistoryEntry = {
      fromStatus: current,
      toStatus: next,
      reason,
      explanation,
      updatedBy,
      timestamp: rows[0]?.created_at ? new Date(rows[0].created_at) : new Date(),
    };

    logger.info(`[StatusWorkflow] Transaction ${txId} transitioned: ${current} -> ${next} (${explanation})`);
    return entry;
  }

  /**
   * Get complete status history and explanation timeline for a transaction.
   */
  public async getHistory(txId: string): Promise<StatusHistoryEntry[]> {
    const { rows } = await pool.query<{
      from_status: string | null;
      to_status: string;
      reason: string | null;
      explanation: string;
      updated_by: string;
      created_at: Date;
    }>(
      `SELECT from_status, to_status, reason, explanation, updated_by, created_at
         FROM transaction_status_history
        WHERE transaction_id = $1
        ORDER BY created_at ASC, id ASC`,
      [txId],
    );

    return rows.map((row) => ({
      fromStatus: (row.from_status ?? undefined) as StatusHistoryEntry["fromStatus"],
      toStatus: row.to_status as StatusHistoryEntry["toStatus"],
      reason: row.reason ?? undefined,
      explanation: row.explanation,
      updatedBy: row.updated_by,
      timestamp: new Date(row.created_at),
    }));
  }

  /**
   * Get human-readable explanation for a given status.
   */
  public getStatusExplanation(status: DetailedStatus): string {
    return TransactionStatusWorkflowService.EXPLANATIONS[status] || "Status updated.";
  }
}

export const transactionStatusWorkflowService = new TransactionStatusWorkflowService();
