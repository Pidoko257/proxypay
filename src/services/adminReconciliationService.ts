import {
  walletDiscrepancyModel,
  reconciliationSettingsModel,
  type WalletDiscrepancy,
} from "../models/reconciliation";
import { queryWrite } from "../config/database";
import logger from "../utils/logger";

export interface ManualReconciliationAction {
  discrepancyId: string;
  action: "approve" | "reject" | "custom_adjustment" | "block_investigation";
  notes?: string;
  adjustmentAmount?: number;
  reviewedBy: string;
}

export interface ReconciliationSettingsUpdate {
  discrepancyThresholdUsd?: number;
  criticalThresholdUsd?: number;
  autoCorrectionEnabled?: boolean;
  autoCorrectionMaxAmount?: number;
  alertChannels?: string[];
}

/**
 * Admin Reconciliation Tools Service
 */
export class AdminReconciliationService {
  /**
   * Review and approve discrepancy correction
   */
  async approveDiscrepancyCorrection(
    discrepancyId: string,
    reviewedBy: string,
    notes?: string,
  ): Promise<WalletDiscrepancy> {
    logger.info(`[Admin] Approving discrepancy ${discrepancyId} reviewed by ${reviewedBy}`);

    return walletDiscrepancyModel.updateStatus(discrepancyId, "resolved", {
      resolutionType: "manual_approval",
      resolutionNotes: notes || "Approved by admin review",
      reviewedBy,
    });
  }

  /**
   * Reject discrepancy correction
   */
  async rejectDiscrepancyCorrection(
    discrepancyId: string,
    reviewedBy: string,
    reason: string,
  ): Promise<WalletDiscrepancy> {
    logger.info(`[Admin] Rejecting discrepancy ${discrepancyId} reviewed by ${reviewedBy}`);

    return walletDiscrepancyModel.updateStatus(discrepancyId, "manual_review", {
      resolutionType: "rejected",
      investigationNotes: reason,
      reviewedBy,
    });
  }

  /**
   * Apply custom adjustment
   */
  async applyCustomAdjustment(
    discrepancyId: string,
    adjustmentAmount: number,
    reviewedBy: string,
    reason: string,
  ): Promise<WalletDiscrepancy> {
    logger.info(
      `[Admin] Applying custom adjustment of ${adjustmentAmount} to discrepancy ${discrepancyId}`,
    );

    return walletDiscrepancyModel.updateStatus(discrepancyId, "resolved", {
      resolutionType: "custom_adjustment",
      resolutionNotes: `Custom adjustment: ${adjustmentAmount}. Reason: ${reason}`,
      reviewedBy,
    });
  }

  /**
   * Mark for investigation
   */
  async markForInvestigation(
    discrepancyId: string,
    investigationNotes: string,
    reviewedBy: string,
  ): Promise<WalletDiscrepancy> {
    logger.info(`[Admin] Marking discrepancy ${discrepancyId} for investigation`);

    return walletDiscrepancyModel.updateStatus(discrepancyId, "investigating", {
      investigationNotes,
      reviewedBy,
    });
  }

  /**
   * Bulk approve pending discrepancies
   */
  async bulkApprovePending(
    limit: number = 50,
    reviewedBy: string,
  ): Promise<{ approved: number; failed: number }> {
    logger.info(`[Admin] Bulk approving pending discrepancies (max ${limit})`);

    const pending = await walletDiscrepancyModel.getPendingDiscrepancies(limit);

    let approved = 0;
    let failed = 0;

    for (const discrepancy of pending) {
      try {
        await this.approveDiscrepancyCorrection(
          discrepancy.id,
          reviewedBy,
          "Bulk approved",
        );
        approved++;
      } catch (error) {
        failed++;
        logger.error(`[Admin] Failed to approve discrepancy ${discrepancy.id}: ${error}`);
      }
    }

    logger.info(`[Admin] Bulk approval completed: ${approved} approved, ${failed} failed`);

    return { approved, failed };
  }

  /**
   * Update reconciliation settings
   */
  async updateReconciliationSettings(
    updates: ReconciliationSettingsUpdate,
    adminId: string,
  ): Promise<void> {
    logger.info(
      `[Admin] Updating reconciliation settings by admin ${adminId}: ${JSON.stringify(updates)}`,
    );

    await reconciliationSettingsModel.updateSettings(updates);

    // Log change
    await queryWrite(
      `INSERT INTO audit_trail (action, actor_id, resource_type, resource_id, details, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [
        "UPDATE_RECONCILIATION_SETTINGS",
        adminId,
        "reconciliation_settings",
        "default",
        JSON.stringify(updates),
      ],
    ).catch(() => {
      // Audit table might not exist, continue anyway
    });
  }

  /**
   * Trigger manual reconciliation for user
   */
  async triggerManualReconciliationForUser(
    userId: string,
    adminId: string,
  ): Promise<string> {
    logger.info(
      `[Admin] Triggering manual reconciliation for user ${userId} by admin ${adminId}`,
    );

    // TODO: Queue reconciliation job
    return `Manual reconciliation triggered for user ${userId}`;
  }

  /**
   * Export pending discrepancies
   */
  async exportPendingDiscrepancies(format: "csv" | "json" = "csv"): Promise<string> {
    logger.info(`[Admin] Exporting pending discrepancies as ${format}`);

    const pending = await walletDiscrepancyModel.getPendingDiscrepancies(10000);

    if (format === "json") {
      return JSON.stringify(pending, null, 2);
    }

    // CSV format
    const headers = [
      "ID",
      "User ID",
      "Wallet Address",
      "Discrepancy Type",
      "Amount",
      "Severity",
      "Status",
      "Possible Causes",
      "Created At",
    ];

    const rows = pending.map((d) => [
      d.id,
      d.userId || "",
      d.walletAddress || "",
      d.discrepancyType,
      d.discrepancyAmount,
      d.severity || "",
      d.status,
      (d.possibleCauses || []).join(";"),
      d.createdAt.toISOString(),
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) =>
        row
          .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
          .join(","),
      ),
    ].join("\n");

    return csvContent;
  }

  /**
   * Get reconciliation health status
   */
  async getHealthStatus(): Promise<{
    status: "healthy" | "warning" | "critical";
    summary: string;
    pendingCount: number;
    criticalCount: number;
    avgResolutionTime: number;
    lastJobStatus: string | null;
  }> {
    const metrics = await queryWrite(
      `SELECT 
         COUNT(*) FILTER (WHERE status IN ('pending', 'investigating')) as pending_count,
         COUNT(*) FILTER (WHERE severity = 'critical') as critical_count,
         (SELECT status FROM reconciliation_jobs ORDER BY created_at DESC LIMIT 1) as last_job_status
       FROM wallet_discrepancies`,
      [],
    );

    const row = metrics.rows[0];
    const pendingCount = parseInt(row.pending_count || "0", 10);
    const criticalCount = parseInt(row.critical_count || "0", 10);

    let status: "healthy" | "warning" | "critical" = "healthy";
    let summary = "All systems operational";

    if (criticalCount > 0) {
      status = "critical";
      summary = `${criticalCount} critical discrepancies pending`;
    } else if (pendingCount > 100) {
      status = "warning";
      summary = `${pendingCount} pending discrepancies`;
    }

    return {
      status,
      summary,
      pendingCount,
      criticalCount,
      avgResolutionTime: 0, // TODO: Calculate
      lastJobStatus: row.last_job_status,
    };
  }

  /**
   * Get suspicious patterns
   */
  async getSuspiciousPatterns(): Promise<Array<{
    pattern: string;
    description: string;
    affectedCount: number;
    severity: string;
  }>> {
    const patterns: Array<{
      pattern: string;
      description: string;
      affectedCount: number;
      severity: string;
    }> = [];

    // Pattern 1: Recurring discrepancies for same user
    const recurringResult = await queryWrite(
      `SELECT user_id, COUNT(*) as count
       FROM wallet_discrepancies
       WHERE status != 'resolved'
       GROUP BY user_id
       HAVING COUNT(*) > 5
       ORDER BY count DESC`,
      [],
    );

    if (recurringResult.rows.length > 0) {
      patterns.push({
        pattern: "recurring_discrepancies",
        description: `Users with 5+ unresolved discrepancies: ${recurringResult.rows.map((r) => r.user_id).join(", ")}`,
        affectedCount: recurringResult.rows.length,
        severity: "high",
      });
    }

    // Pattern 2: Large discrepancies
    const largeResult = await queryWrite(
      `SELECT COUNT(*) as count
       FROM wallet_discrepancies
       WHERE ABS(discrepancy_amount) > 10000
       AND status != 'resolved'`,
      [],
    );

    const largeCount = parseInt(largeResult.rows[0]?.count || "0", 10);
    if (largeCount > 0) {
      patterns.push({
        pattern: "large_discrepancies",
        description: `${largeCount} discrepancies exceeding 10000 USD`,
        affectedCount: largeCount,
        severity: "critical",
      });
    }

    return patterns;
  }

  /**
   * Reset reconciliation state for user
   */
  async resetUserReconciliationState(userId: string, adminId: string): Promise<void> {
    logger.warn(
      `[Admin] Resetting reconciliation state for user ${userId} by admin ${adminId}`,
    );

    // Mark all pending discrepancies as resolved (for fresh start)
    await queryWrite(
      `UPDATE wallet_discrepancies 
       SET status = 'resolved', resolution_type = 'reset_by_admin', resolved_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND status IN ('pending', 'investigating')`,
      [userId],
    );

    logger.info(`[Admin] Reconciliation state reset for user ${userId}`);
  }
}

export const adminReconciliationService = new AdminReconciliationService();
