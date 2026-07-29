import { queryRead } from "../config/database";
import { walletDiscrepancyModel, reconciliationJobModel } from "../models/reconciliation";
import { Decimal } from "decimal.js";

export interface ReconciliationReport {
  periodStart: Date;
  periodEnd: Date;
  totalJobsRun: number;
  totalDiscrepanciesFound: number;
  totalAutoCorrections: number;
  totalManualReviews: number;
  averageResolutionTime: number;
  discrepanciesBySeverity: Record<string, number>;
  discrepanciesByType: Record<string, number>;
  successRate: number;
  totalAmountDiscrepancies: number;
  topAffectedUsers: Array<{
    userId: string;
    discrepancyCount: number;
    totalAmount: number;
  }>;
}

export interface DashboardMetrics {
  pendingDiscrepancies: number;
  resolvedDiscrepancies: number;
  criticalDiscrepancies: number;
  lastReconciliationTime: Date | null;
  lastReconciliationStatus: string | null;
  autoCorrectionsToday: number;
  averageReconciliationTime: number;
  discrepancyDetectionRate: number;
}

/**
 * Reconciliation Report and Dashboard Service
 */
export class ReconciliationReportService {
  /**
   * Generate reconciliation report for period
   */
  async generateReport(periodStart: Date, periodEnd: Date): Promise<ReconciliationReport> {
    // Get all jobs in period
    const jobsResult = await queryRead(
      `SELECT * FROM reconciliation_jobs 
       WHERE created_at >= $1 AND created_at < $2 
       AND status IN ('completed', 'partial')
       ORDER BY created_at DESC`,
      [periodStart, periodEnd],
    );

    const jobs = jobsResult.rows;
    const totalJobsRun = jobs.length;

    // Get all discrepancies in period
    const discrepanciesResult = await queryRead(
      `SELECT * FROM wallet_discrepancies 
       WHERE created_at >= $1 AND created_at < $2`,
      [periodStart, periodEnd],
    );

    const discrepancies = discrepanciesResult.rows;
    const totalDiscrepanciesFound = discrepancies.length;

    // Calculate metrics
    const totalAutoCorrections = jobs.reduce((sum, job) => sum + (job.auto_corrections || 0), 0);
    const totalManualReviews = jobs.reduce((sum, job) => sum + (job.manual_reviews_needed || 0), 0);

    // Calculate resolution time (in hours)
    let averageResolutionTime = 0;
    const resolvedDiscrepancies = discrepancies.filter((d) => d.resolved_at);
    if (resolvedDiscrepancies.length > 0) {
      const totalTime = resolvedDiscrepancies.reduce((sum, d) => {
        const createdAt = new Date(d.created_at).getTime();
        const resolvedAt = new Date(d.resolved_at).getTime();
        return sum + (resolvedAt - createdAt);
      }, 0);
      averageResolutionTime = Math.round(totalTime / resolvedDiscrepancies.length / (1000 * 60 * 60)); // Convert to hours
    }

    // Discrepancies by severity
    const discrepanciesBySeverity: Record<string, number> = {};
    discrepancies.forEach((d) => {
      const severity = d.severity || "unknown";
      discrepanciesBySeverity[severity] = (discrepanciesBySeverity[severity] || 0) + 1;
    });

    // Discrepancies by type
    const discrepanciesByType: Record<string, number> = {};
    discrepancies.forEach((d) => {
      discrepanciesByType[d.discrepancy_type] = (discrepanciesByType[d.discrepancy_type] || 0) + 1;
    });

    // Success rate
    const successfulJobs = jobs.filter((j) => j.status === "completed").length;
    const successRate = totalJobsRun > 0 ? (successfulJobs / totalJobsRun) * 100 : 0;

    // Total amount of discrepancies
    const totalAmountDiscrepancies = discrepancies.reduce((sum, d) => {
      return sum + parseFloat(d.discrepancy_amount || "0");
    }, 0);

    // Top affected users
    const userDiscrepanciesMap = new Map<string, { count: number; amount: number }>();
    discrepancies.forEach((d) => {
      if (d.user_id) {
        const existing = userDiscrepanciesMap.get(d.user_id) || { count: 0, amount: 0 };
        userDiscrepanciesMap.set(d.user_id, {
          count: existing.count + 1,
          amount: existing.amount + parseFloat(d.discrepancy_amount || "0"),
        });
      }
    });

    const topAffectedUsers = Array.from(userDiscrepanciesMap.entries())
      .map(([userId, data]) => ({
        userId,
        discrepancyCount: data.count,
        totalAmount: data.amount,
      }))
      .sort((a, b) => b.discrepancyCount - a.discrepancyCount)
      .slice(0, 10);

    return {
      periodStart,
      periodEnd,
      totalJobsRun,
      totalDiscrepanciesFound,
      totalAutoCorrections,
      totalManualReviews,
      averageResolutionTime,
      discrepanciesBySeverity,
      discrepanciesByType,
      successRate,
      totalAmountDiscrepancies,
      topAffectedUsers,
    };
  }

  /**
   * Get dashboard metrics
   */
  async getDashboardMetrics(): Promise<DashboardMetrics> {
    // Pending discrepancies
    const pendingResult = await queryRead(
      `SELECT COUNT(*) as count FROM wallet_discrepancies 
       WHERE status IN ('pending', 'investigating')`,
      [],
    );
    const pendingDiscrepancies = parseInt(pendingResult.rows[0]?.count || "0", 10);

    // Resolved discrepancies
    const resolvedResult = await queryRead(
      `SELECT COUNT(*) as count FROM wallet_discrepancies 
       WHERE status = 'resolved'`,
      [],
    );
    const resolvedDiscrepancies = parseInt(resolvedResult.rows[0]?.count || "0", 10);

    // Critical discrepancies
    const criticalResult = await queryRead(
      `SELECT COUNT(*) as count FROM wallet_discrepancies 
       WHERE severity = 'critical' AND status != 'resolved'`,
      [],
    );
    const criticalDiscrepancies = parseInt(criticalResult.rows[0]?.count || "0", 10);

    // Last reconciliation
    const lastJobResult = await queryRead(
      `SELECT completed_at, status FROM reconciliation_jobs 
       WHERE status IN ('completed', 'partial')
       ORDER BY completed_at DESC 
       LIMIT 1`,
      [],
    );

    const lastReconciliationTime = lastJobResult.rows[0]?.completed_at
      ? new Date(lastJobResult.rows[0].completed_at)
      : null;
    const lastReconciliationStatus = lastJobResult.rows[0]?.status || null;

    // Auto-corrections today
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const autoCorrectionsResult = await queryRead(
      `SELECT COUNT(*) as count FROM wallet_discrepancies 
       WHERE status = 'auto_corrected' AND created_at >= $1`,
      [todayStart],
    );
    const autoCorrectionsToday = parseInt(autoCorrectionsResult.rows[0]?.count || "0", 10);

    // Average reconciliation time (last 7 days)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const avgTimeResult = await queryRead(
      `SELECT AVG(duration_ms) as avg_duration FROM reconciliation_jobs 
       WHERE status IN ('completed', 'partial') AND created_at >= $1`,
      [weekAgo],
    );
    const averageReconciliationTime = Math.round(
      parseFloat(avgTimeResult.rows[0]?.avg_duration || "0") / 1000,
    ); // Convert to seconds

    // Discrepancy detection rate (ratio of jobs with discrepancies)
    const jobsResult = await queryRead(
      `SELECT COUNT(*) as total, 
              COUNT(*) FILTER (WHERE discrepancies_found > 0) as with_discrepancies
       FROM reconciliation_jobs 
       WHERE created_at >= $1`,
      [weekAgo],
    );
    const totalJobs = parseInt(jobsResult.rows[0]?.total || "1", 10);
    const jobsWithDiscrepancies = parseInt(jobsResult.rows[0]?.with_discrepancies || "0", 10);
    const discrepancyDetectionRate =
      totalJobs > 0 ? (jobsWithDiscrepancies / totalJobs) * 100 : 0;

    return {
      pendingDiscrepancies,
      resolvedDiscrepancies,
      criticalDiscrepancies,
      lastReconciliationTime,
      lastReconciliationStatus,
      autoCorrectionsToday,
      averageReconciliationTime,
      discrepancyDetectionRate,
    };
  }

  /**
   * Get reconciliation history chart data
   */
  async getHistoryChartData(days: number = 30): Promise<Array<{
    date: string;
    discrepancies: number;
    resolved: number;
    pending: number;
  }>> {
    const startDate = new Date();
    startDate.setUTCDate(startDate.getUTCDate() - days);
    startDate.setUTCHours(0, 0, 0, 0);

    const result = await queryRead(
      `SELECT 
         DATE(created_at) as date,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
         COUNT(*) FILTER (WHERE status IN ('pending', 'investigating')) as pending
       FROM wallet_discrepancies
       WHERE created_at >= $1
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at)`,
      [startDate],
    );

    return result.rows.map((row) => ({
      date: row.date,
      discrepancies: parseInt(row.total || "0", 10),
      resolved: parseInt(row.resolved || "0", 10),
      pending: parseInt(row.pending || "0", 10),
    }));
  }

  /**
   * Get severity distribution chart data
   */
  async getSeverityDistribution(): Promise<Array<{
    severity: string;
    count: number;
    percentage: number;
  }>> {
    const result = await queryRead(
      `SELECT severity, COUNT(*) as count
       FROM wallet_discrepancies
       WHERE status != 'resolved'
       GROUP BY severity
       ORDER BY count DESC`,
      [],
    );

    const totalCount = result.rows.reduce((sum, row) => sum + parseInt(row.count || "0", 10), 0);

    return result.rows.map((row) => ({
      severity: row.severity,
      count: parseInt(row.count || "0", 10),
      percentage: totalCount > 0 ? (parseInt(row.count || "0", 10) / totalCount) * 100 : 0,
    }));
  }

  /**
   * Get discrepancy type distribution
   */
  async getTypeDistribution(): Promise<Array<{
    type: string;
    count: number;
    percentage: number;
  }>> {
    const result = await queryRead(
      `SELECT discrepancy_type, COUNT(*) as count
       FROM wallet_discrepancies
       GROUP BY discrepancy_type
       ORDER BY count DESC`,
      [],
    );

    const totalCount = result.rows.reduce((sum, row) => sum + parseInt(row.count || "0", 10), 0);

    return result.rows.map((row) => ({
      type: row.discrepancy_type,
      count: parseInt(row.count || "0", 10),
      percentage: totalCount > 0 ? (parseInt(row.count || "0", 10) / totalCount) * 100 : 0,
    }));
  }

  /**
   * Export report to CSV
   */
  async exportReportToCsv(
    periodStart: Date,
    periodEnd: Date,
  ): Promise<string> {
    const discrepanciesResult = await queryRead(
      `SELECT * FROM wallet_discrepancies 
       WHERE created_at >= $1 AND created_at < $2
       ORDER BY created_at DESC`,
      [periodStart, periodEnd],
    );

    const headers = [
      "ID",
      "User ID",
      "Wallet Address",
      "Discrepancy Type",
      "Amount",
      "Ledger Balance",
      "Stellar Balance",
      "Status",
      "Severity",
      "Created At",
      "Resolved At",
    ];

    const rows = discrepanciesResult.rows.map((row) => [
      row.id,
      row.user_id || "",
      row.wallet_address || "",
      row.discrepancy_type,
      row.discrepancy_amount,
      row.ledger_balance || "",
      row.stellar_balance || "",
      row.status,
      row.severity || "",
      row.created_at,
      row.resolved_at || "",
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")),
    ].join("\n");

    return csvContent;
  }
}

export const reconciliationReportService = new ReconciliationReportService();
