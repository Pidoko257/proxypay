import { pool } from "../config/database";
import { env } from "../config/env";
import { logAuditEvent } from "./auditlogService";

export interface TimeTravelOptions {
  asOfTimestamp?: Date | string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface SoftDeletePurgeReport {
  usersPurgedCount: number;
  transactionsPurgedCount: number;
  retentionCutoff: Date;
}

export class SoftDeleteService {
  /**
   * Soft delete a user by setting deleted_at to current timestamp and recording audit log
   */
  async softDeleteUser(userId: string, actorId: string): Promise<boolean> {
    const result = await pool.query(
      "UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL RETURNING id",
      [userId],
    );
    if (result.rows.length === 0) return false;

    await logAuditEvent({
      action: "USER_SOFT_DELETED",
      actorId,
      targetId: userId,
      details: { deletedAt: new Date().toISOString() },
    }).catch((err) => console.error("[soft-delete] Audit logging failed:", err));

    return true;
  }

  /**
   * Restore a soft-deleted user by setting deleted_at to NULL
   */
  async restoreUser(userId: string, actorId: string): Promise<boolean> {
    const result = await pool.query(
      "UPDATE users SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id",
      [userId],
    );
    if (result.rows.length === 0) return false;

    await logAuditEvent({
      action: "USER_RESTORED",
      actorId,
      targetId: userId,
      details: { restoredAt: new Date().toISOString() },
    }).catch((err) => console.error("[soft-delete] Audit logging failed:", err));

    return true;
  }

  /**
   * Soft delete a transaction by setting deleted_at to current timestamp and recording audit log
   */
  async softDeleteTransaction(transactionId: string, actorId: string): Promise<boolean> {
    const result = await pool.query(
      "UPDATE transactions SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL RETURNING id",
      [transactionId],
    );
    if (result.rows.length === 0) return false;

    await logAuditEvent({
      action: "TRANSACTION_SOFT_DELETED",
      actorId,
      targetId: transactionId,
      details: { deletedAt: new Date().toISOString() },
    }).catch((err) => console.error("[soft-delete] Audit logging failed:", err));

    return true;
  }

  /**
   * Restore a soft-deleted transaction
   */
  async restoreTransaction(transactionId: string, actorId: string): Promise<boolean> {
    const result = await pool.query(
      "UPDATE transactions SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id",
      [transactionId],
    );
    if (result.rows.length === 0) return false;

    await logAuditEvent({
      action: "TRANSACTION_RESTORED",
      actorId,
      targetId: transactionId,
      details: { restoredAt: new Date().toISOString() },
    }).catch((err) => console.error("[soft-delete] Audit logging failed:", err));

    return true;
  }

  /**
   * Time Travel query support for users table:
   * Query historical state as of a given timestamp or include deleted records for auditing.
   */
  async getUsersWithTimeTravel(options: TimeTravelOptions = {}): Promise<any[]> {
    const { asOfTimestamp, includeDeleted = false, limit = 50, offset = 0 } = options;
    const params: any[] = [];
    let query = "SELECT * FROM users WHERE 1=1";

    if (asOfTimestamp) {
      params.push(new Date(asOfTimestamp));
      query += ` AND created_at <= $${params.length}`;
      query += ` AND (deleted_at IS NULL OR deleted_at > $${params.length})`;
    } else if (!includeDeleted) {
      query += " AND deleted_at IS NULL";
    }

    params.push(limit, offset);
    query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Time Travel query support for transactions table:
   * Query historical state as of a given timestamp or include deleted records for auditing.
   */
  async getTransactionsWithTimeTravel(options: TimeTravelOptions = {}): Promise<any[]> {
    const { asOfTimestamp, includeDeleted = false, limit = 50, offset = 0 } = options;
    const params: any[] = [];
    let query = "SELECT * FROM transactions WHERE 1=1";

    if (asOfTimestamp) {
      params.push(new Date(asOfTimestamp));
      query += ` AND created_at <= $${params.length}`;
      query += ` AND (deleted_at IS NULL OR deleted_at > $${params.length})`;
    } else if (!includeDeleted) {
      query += " AND deleted_at IS NULL";
    }

    params.push(limit, offset);
    query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Purge job: Hard delete records only after retention period (e.g. 90 days default)
   */
  async purgeSoftDeletedRecords(retentionDays: number = env.SOFT_DELETE_RETENTION_DAYS): Promise<SoftDeletePurgeReport> {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    console.info(`[soft-delete-purge] Purging soft-deleted records deleted prior to ${cutoffDate.toISOString()}`);

    const userPurgeResult = await pool.query(
      "DELETE FROM users WHERE deleted_at IS NOT NULL AND deleted_at < $1 RETURNING id",
      [cutoffDate],
    );

    const txPurgeResult = await pool.query(
      "DELETE FROM transactions WHERE deleted_at IS NOT NULL AND deleted_at < $1 RETURNING id",
      [cutoffDate],
    );

    const report: SoftDeletePurgeReport = {
      usersPurgedCount: userPurgeResult.rows.length,
      transactionsPurgedCount: txPurgeResult.rows.length,
      retentionCutoff: cutoffDate,
    };

    if (report.usersPurgedCount > 0 || report.transactionsPurgedCount > 0) {
      await logAuditEvent({
        action: "SOFT_DELETED_RECORDS_PURGED",
        actorId: "SYSTEM_PURGE_JOB",
        targetId: "SYSTEM",
        details: report,
      }).catch((err) => console.error("[soft-delete-purge] Audit logging failed:", err));
    }

    console.info(
      `[soft-delete-purge] Purge complete. Hard deleted ${report.usersPurgedCount} users and ${report.transactionsPurgedCount} transactions.`,
    );

    return report;
  }
}

export const softDeleteService = new SoftDeleteService();
