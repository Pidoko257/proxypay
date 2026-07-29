import { queryRead, queryWrite } from "../config/database";
import { smsDeliveryTrackingModel } from "../models/smsDeliveryTracking";

export interface SmsBillingRecord {
  id: string;
  userId?: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  smsSentCount: number;
  smsDeliveredCount: number;
  smsFailedCount: number;
  totalCostUsd: number;
  transactionSms: number;
  kycSms: number;
  alertSms: number;
  otherSms: number;
  createdAt: Date;
  updatedAt: Date;
  finalizedAt?: Date;
}

export interface SmsCostReport {
  period: { start: Date; end: Date };
  totalUsers: number;
  totalSmsCount: number;
  totalCostUsd: number;
  averageCostPerUser: number;
  costBreakdown: {
    transactionSms: number;
    kycSms: number;
    alertSms: number;
    otherSms: number;
  };
  successRate: number;
}

/**
 * SMS Billing and Cost Tracking Service
 */
export class SmsBillingService {
  /**
   * Generate billing record for a user for a specific period
   */
  async generateBillingRecord(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<SmsBillingRecord> {
    // Get SMS statistics for the period
    const costs = await smsDeliveryTrackingModel.getCostSummary(userId, periodStart, periodEnd);

    // Get SMS count by type
    const result = await queryRead(
      `SELECT 
         COUNT(*) FILTER (WHERE message_type = 'transaction_success' OR message_type = 'transaction_failure') as transaction_sms,
         COUNT(*) FILTER (WHERE message_type = 'kyc_update') as kyc_sms,
         COUNT(*) FILTER (WHERE message_type = 'alert') as alert_sms,
         COUNT(*) FILTER (WHERE message_type NOT IN ('transaction_success', 'transaction_failure', 'kyc_update', 'alert')) as other_sms,
         COUNT(*) FILTER (WHERE status IN ('sent', 'delivered')) as delivered,
         COUNT(*) FILTER (WHERE status = 'failed') as failed,
         COUNT(*) as total
       FROM sms_delivery_tracking
       WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
      [userId, periodStart, periodEnd],
    );

    const row = result.rows[0];

    // Create or update billing record
    const existingResult = await queryRead(
      `SELECT * FROM sms_billing_summary 
       WHERE user_id = $1 
         AND billing_period_start = $2 
         AND billing_period_end = $3`,
      [userId, periodStart, periodEnd],
    );

    let billing: SmsBillingRecord;

    if (existingResult.rows.length > 0) {
      // Update existing record
      const updateResult = await queryWrite(
        `UPDATE sms_billing_summary
         SET sms_count_sent = $2,
             sms_count_delivered = $3,
             sms_count_failed = $4,
             total_cost_usd = $5,
             transaction_sms = $6,
             kyc_sms = $7,
             alert_sms = $8,
             other_sms = $9
         WHERE user_id = $1 
           AND billing_period_start = $10
           AND billing_period_end = $11
         RETURNING *`,
        [
          userId,
          parseInt(row.total || "0", 10),
          parseInt(row.delivered || "0", 10),
          parseInt(row.failed || "0", 10),
          costs.totalCost,
          parseInt(row.transaction_sms || "0", 10),
          parseInt(row.kyc_sms || "0", 10),
          parseInt(row.alert_sms || "0", 10),
          parseInt(row.other_sms || "0", 10),
          periodStart,
          periodEnd,
        ],
      );
      billing = this.mapBillingRow(updateResult.rows[0]);
    } else {
      // Create new record
      const insertResult = await queryWrite(
        `INSERT INTO sms_billing_summary
         (user_id, billing_period_start, billing_period_end, sms_count_sent, sms_count_delivered,
          sms_count_failed, total_cost_usd, transaction_sms, kyc_sms, alert_sms, other_sms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          userId,
          periodStart,
          periodEnd,
          parseInt(row.total || "0", 10),
          parseInt(row.delivered || "0", 10),
          parseInt(row.failed || "0", 10),
          costs.totalCost,
          parseInt(row.transaction_sms || "0", 10),
          parseInt(row.kyc_sms || "0", 10),
          parseInt(row.alert_sms || "0", 10),
          parseInt(row.other_sms || "0", 10),
        ],
      );
      billing = this.mapBillingRow(insertResult.rows[0]);
    }

    return billing;
  }

  /**
   * Get billing record for a user for a specific period
   */
  async getBillingRecord(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<SmsBillingRecord | null> {
    const result = await queryRead(
      `SELECT * FROM sms_billing_summary 
       WHERE user_id = $1 
         AND billing_period_start = $2 
         AND billing_period_end = $3`,
      [userId, periodStart, periodEnd],
    );

    if (result.rows.length === 0) return null;
    return this.mapBillingRow(result.rows[0]);
  }

  /**
   * Get billing records for a user within a date range
   */
  async getUserBillingRecords(
    userId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<SmsBillingRecord[]> {
    const result = await queryRead(
      `SELECT * FROM sms_billing_summary 
       WHERE user_id = $1 
         AND billing_period_start >= $2 
         AND billing_period_end <= $3
       ORDER BY billing_period_start DESC`,
      [userId, startDate, endDate],
    );

    return result.rows.map((row) => this.mapBillingRow(row));
  }

  /**
   * Finalize billing record (mark as complete)
   */
  async finalizeBillingRecord(recordId: string): Promise<SmsBillingRecord> {
    const result = await queryWrite(
      `UPDATE sms_billing_summary 
       SET finalized_at = CURRENT_TIMESTAMP 
       WHERE id = $1 
       RETURNING *`,
      [recordId],
    );

    return this.mapBillingRow(result.rows[0]);
  }

  /**
   * Generate company-wide SMS cost report
   */
  async generateCostReport(startDate: Date, endDate: Date): Promise<SmsCostReport> {
    // Get overall statistics
    const overallResult = await queryRead(
      `SELECT 
         COUNT(DISTINCT user_id) as total_users,
         COUNT(*) FILTER (WHERE status IN ('sent', 'delivered')) as delivered,
         COUNT(*) FILTER (WHERE status = 'failed') as failed,
         COUNT(*) as total,
         SUM(COALESCE(cost_usd, 0)) as total_cost
       FROM sms_delivery_tracking
       WHERE created_at >= $1 AND created_at < $2`,
      [startDate, endDate],
    );

    const overallRow = overallResult.rows[0];
    const totalUsers = parseInt(overallRow.total_users || "0", 10);
    const totalDelivered = parseInt(overallRow.delivered || "0", 10);
    const totalFailed = parseInt(overallRow.failed || "0", 10);
    const totalCount = parseInt(overallRow.total || "0", 10);
    const totalCost = parseFloat(overallRow.total_cost || "0");

    // Get cost breakdown by message type
    const typeResult = await queryRead(
      `SELECT 
         COUNT(*) FILTER (WHERE message_type IN ('transaction_success', 'transaction_failure')) as transaction_sms,
         COUNT(*) FILTER (WHERE message_type = 'kyc_update') as kyc_sms,
         COUNT(*) FILTER (WHERE message_type = 'alert') as alert_sms,
         COUNT(*) FILTER (WHERE message_type NOT IN ('transaction_success', 'transaction_failure', 'kyc_update', 'alert')) as other_sms
       FROM sms_delivery_tracking
       WHERE created_at >= $1 AND created_at < $2`,
      [startDate, endDate],
    );

    const typeRow = typeResult.rows[0];

    return {
      period: { start: startDate, end: endDate },
      totalUsers,
      totalSmsCount: totalCount,
      totalCostUsd: totalCost,
      averageCostPerUser: totalUsers > 0 ? totalCost / totalUsers : 0,
      costBreakdown: {
        transactionSms: parseInt(typeRow.transaction_sms || "0", 10),
        kycSms: parseInt(typeRow.kyc_sms || "0", 10),
        alertSms: parseInt(typeRow.alert_sms || "0", 10),
        otherSms: parseInt(typeRow.other_sms || "0", 10),
      },
      successRate: totalCount > 0 ? (totalDelivered / totalCount) * 100 : 0,
    };
  }

  /**
   * Get user billing summary for current month
   */
  async getUserMonthlyBilling(userId: string): Promise<SmsBillingRecord | null> {
    const now = new Date();
    const monthStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const monthEnd = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);

    return this.generateBillingRecord(userId, monthStart, monthEnd);
  }

  /**
   * Export billing data to CSV
   */
  async exportBillingDataCsv(startDate: Date, endDate: Date): Promise<string> {
    const result = await queryRead(
      `SELECT 
         user_id,
         billing_period_start,
         billing_period_end,
         sms_count_sent,
         sms_count_delivered,
         sms_count_failed,
         total_cost_usd,
         transaction_sms,
         kyc_sms,
         alert_sms,
         other_sms
       FROM sms_billing_summary
       WHERE billing_period_start >= $1 AND billing_period_end <= $2
       ORDER BY billing_period_start DESC, user_id`,
      [startDate, endDate],
    );

    // Build CSV
    const headers = [
      "User ID",
      "Period Start",
      "Period End",
      "SMS Sent",
      "SMS Delivered",
      "SMS Failed",
      "Total Cost (USD)",
      "Transaction SMS",
      "KYC SMS",
      "Alert SMS",
      "Other SMS",
    ].join(",");

    const rows = result.rows.map((row) =>
      [
        row.user_id || "N/A",
        row.billing_period_start,
        row.billing_period_end,
        row.sms_count_sent,
        row.sms_count_delivered,
        row.sms_count_failed,
        row.total_cost_usd,
        row.transaction_sms,
        row.kyc_sms,
        row.alert_sms,
        row.other_sms,
      ].join(","),
    );

    return [headers, ...rows].join("\n");
  }

  /**
   * Get top SMS costs by user
   */
  async getTopCostUsers(
    limit: number = 10,
    startDate?: Date,
    endDate?: Date,
  ): Promise<
    Array<{
      userId: string;
      totalCost: number;
      smsSent: number;
      smsDelivered: number;
    }>
  > {
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate || new Date();

    const result = await queryRead(
      `SELECT 
         user_id,
         SUM(COALESCE(cost_usd, 0)) as total_cost,
         COUNT(*) FILTER (WHERE status IN ('sent', 'delivered')) as delivered,
         COUNT(*) as total
       FROM sms_delivery_tracking
       WHERE user_id IS NOT NULL
         AND created_at >= $1
         AND created_at < $2
       GROUP BY user_id
       ORDER BY total_cost DESC
       LIMIT $3`,
      [start, end, limit],
    );

    return result.rows.map((row) => ({
      userId: row.user_id,
      totalCost: parseFloat(row.total_cost || "0"),
      smsSent: parseInt(row.total || "0", 10),
      smsDelivered: parseInt(row.delivered || "0", 10),
    }));
  }

  private mapBillingRow(row: any): SmsBillingRecord {
    return {
      id: row.id,
      userId: row.user_id,
      billingPeriodStart: new Date(row.billing_period_start),
      billingPeriodEnd: new Date(row.billing_period_end),
      smsSentCount: row.sms_count_sent || 0,
      smsDeliveredCount: row.sms_count_delivered || 0,
      smsFailedCount: row.sms_count_failed || 0,
      totalCostUsd: parseFloat(row.total_cost_usd || "0"),
      transactionSms: row.transaction_sms || 0,
      kycSms: row.kyc_sms || 0,
      alertSms: row.alert_sms || 0,
      otherSms: row.other_sms || 0,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      finalizedAt: row.finalized_at ? new Date(row.finalized_at) : undefined,
    };
  }
}

export const smsBillingService = new SmsBillingService();
