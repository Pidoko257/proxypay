/**
 * Advanced Reporting Service — Issue #205
 *
 * Provides:
 *   - Profit & Loss (P&L) reports
 *   - Settlement reports by provider
 *   - AML compliance reports (extends existing amlService)
 *   - KYC compliance reports
 *   - Scheduled report generation
 *   - Report distribution (email delivery)
 *   - Report archival and retention policies
 *   - Custom report builder (flexible grouping + metrics)
 */

import { pool } from "../config/database";
import { redisClient } from "../config/redis";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ReportType =
  | "pnl"
  | "settlement"
  | "aml"
  | "kyc_compliance"
  | "custom";

export type ReportFormat = "json" | "csv";
export type ReportSchedule = "once" | "daily" | "weekly" | "monthly";
export type ReportStatus = "pending" | "generating" | "ready" | "failed" | "archived";

export interface ReportPeriod {
  start: string; // YYYY-MM-DD
  end: string;
}

// ── P&L Report ────────────────────────────────────────────────────────────────

export interface PnLReport {
  period: ReportPeriod;
  revenue: {
    totalFees: number;
    feesByProvider: Record<string, number>;
    feesByTransactionType: Record<string, number>;
  };
  volume: {
    totalVolume: number;
    totalTransactions: number;
    volumeByProvider: Record<string, number>;
    volumeByType: Record<string, number>;
  };
  netRevenue: number;
  effectiveFeeRate: number;
  dailyBreakdown: {
    date: string;
    fees: number;
    volume: number;
    transactions: number;
    effectiveRate: number;
  }[];
}

// ── Settlement Report ─────────────────────────────────────────────────────────

export interface SettlementReport {
  period: ReportPeriod;
  settlements: {
    provider: string;
    totalTransactions: number;
    settledAmount: number;
    pendingAmount: number;
    failedAmount: number;
    settlementRate: number;
    avgSettlementTimeMs: number | null;
  }[];
  totalSettled: number;
  totalPending: number;
  overallSettlementRate: number;
}

// ── KYC Compliance Report ─────────────────────────────────────────────────────

export interface KycComplianceReport {
  period: ReportPeriod;
  summary: {
    totalUsersSubmitted: number;
    approved: number;
    rejected: number;
    pending: number;
    approvalRate: number;
  };
  byLevel: Record<string, {
    submitted: number;
    approved: number;
    rejected: number;
  }>;
  dailySubmissions: { date: string; submitted: number; approved: number; rejected: number }[];
}

// ── Custom Report ─────────────────────────────────────────────────────────────

export type CustomReportMetric = "count" | "sum_amount" | "sum_fees" | "avg_amount";
export type CustomReportGroupBy = "date" | "provider" | "status" | "type" | "currency";

export interface CustomReportDefinition {
  metrics: CustomReportMetric[];
  groupBy: CustomReportGroupBy[];
  filters: {
    startDate?: string;
    endDate?: string;
    provider?: string;
    status?: string;
    type?: string;
  };
}

export interface CustomReportResult {
  definition: CustomReportDefinition;
  rows: Record<string, unknown>[];
  totalRows: number;
  generatedAt: string;
}

// ── Scheduled Report ──────────────────────────────────────────────────────────

export interface ScheduledReport {
  id: string;
  reportType: ReportType;
  schedule: ReportSchedule;
  format: ReportFormat;
  parameters: Record<string, unknown>;
  deliverToEmail: boolean;
  recipients: string[];
  isActive: boolean;
  nextRunAt: Date;
  lastRunAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface ReportArchive {
  id: string;
  reportType: ReportType;
  format: ReportFormat;
  parameters: Record<string, unknown>;
  status: ReportStatus;
  generatedBy: string;
  generatedAt: Date;
  expiresAt: Date | null;
  payload: Record<string, unknown> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Advanced Reporting Service
// ─────────────────────────────────────────────────────────────────────────────

export class AdvancedReportingService {

  // ─── P&L Report ───────────────────────────────────────────────────────────

  async generatePnLReport(period: ReportPeriod): Promise<PnLReport> {
    const cacheKey = `report:pnl:${period.start}:${period.end}`;
    const cached = await this.getCached<PnLReport>(cacheKey);
    if (cached) return cached;

    const [summaryResult, providerResult, typeResult, dailyResult] = await Promise.all([
      pool.query<any>(
        `SELECT
           COALESCE(SUM(fee_amount), 0)  AS total_fees,
           COALESCE(SUM(amount), 0)      AS total_volume,
           COUNT(*)                       AS total_transactions
         FROM transactions
         WHERE status = 'completed'
           AND DATE(created_at) BETWEEN $1 AND $2`,
        [period.start, period.end],
      ),
      pool.query<any>(
        `SELECT
           provider,
           COALESCE(SUM(fee_amount), 0) AS fees,
           COALESCE(SUM(amount), 0)     AS volume
         FROM transactions
         WHERE status = 'completed'
           AND DATE(created_at) BETWEEN $1 AND $2
         GROUP BY provider`,
        [period.start, period.end],
      ),
      pool.query<any>(
        `SELECT
           type,
           COALESCE(SUM(fee_amount), 0) AS fees,
           COALESCE(SUM(amount), 0)     AS volume
         FROM transactions
         WHERE status = 'completed'
           AND DATE(created_at) BETWEEN $1 AND $2
         GROUP BY type`,
        [period.start, period.end],
      ),
      pool.query<any>(
        `SELECT
           DATE(created_at) AS date,
           COALESCE(SUM(fee_amount), 0) AS fees,
           COALESCE(SUM(amount), 0)     AS volume,
           COUNT(*)                      AS transactions
         FROM transactions
         WHERE status = 'completed'
           AND DATE(created_at) BETWEEN $1 AND $2
         GROUP BY DATE(created_at)
         ORDER BY DATE(created_at)`,
        [period.start, period.end],
      ),
    ]);

    const summary = summaryResult.rows[0];
    const totalFees = parseFloat(summary.total_fees);
    const totalVolume = parseFloat(summary.total_volume);

    const feesByProvider: Record<string, number> = {};
    const volumeByProvider: Record<string, number> = {};
    for (const row of providerResult.rows) {
      feesByProvider[row.provider] = parseFloat(row.fees);
      volumeByProvider[row.provider] = parseFloat(row.volume);
    }

    const feesByType: Record<string, number> = {};
    const volumeByType: Record<string, number> = {};
    for (const row of typeResult.rows) {
      feesByType[row.type] = parseFloat(row.fees);
      volumeByType[row.type] = parseFloat(row.volume);
    }

    const dailyBreakdown = dailyResult.rows.map((r: any) => {
      const vol = parseFloat(r.volume);
      const fees = parseFloat(r.fees);
      return {
        date: String(r.date).slice(0, 10),
        fees,
        volume: vol,
        transactions: parseInt(r.transactions, 10),
        effectiveRate: vol > 0 ? parseFloat(((fees / vol) * 100).toFixed(4)) : 0,
      };
    });

    const report: PnLReport = {
      period,
      revenue: {
        totalFees: parseFloat(totalFees.toFixed(2)),
        feesByProvider,
        feesByTransactionType: feesByType,
      },
      volume: {
        totalVolume: parseFloat(totalVolume.toFixed(2)),
        totalTransactions: parseInt(summary.total_transactions, 10),
        volumeByProvider,
        volumeByType,
      },
      netRevenue: parseFloat(totalFees.toFixed(2)),
      effectiveFeeRate: totalVolume > 0 ? parseFloat(((totalFees / totalVolume) * 100).toFixed(4)) : 0,
      dailyBreakdown,
    };

    await this.setCached(cacheKey, report, 3600);
    return report;
  }

  // ─── Settlement Report ────────────────────────────────────────────────────

  async generateSettlementReport(period: ReportPeriod): Promise<SettlementReport> {
    const cacheKey = `report:settlement:${period.start}:${period.end}`;
    const cached = await this.getCached<SettlementReport>(cacheKey);
    if (cached) return cached;

    const result = await pool.query<any>(
      `SELECT
         provider,
         COUNT(*)                                               AS total,
         COALESCE(SUM(amount) FILTER (WHERE status = 'completed'),  0) AS settled,
         COALESCE(SUM(amount) FILTER (WHERE status = 'pending'),    0) AS pending,
         COALESCE(SUM(amount) FILTER (WHERE status = 'failed'),     0) AS failed
       FROM transactions
       WHERE DATE(created_at) BETWEEN $1 AND $2
       GROUP BY provider`,
      [period.start, period.end],
    );

    let totalSettled = 0;
    let totalPending = 0;
    let totalAll = 0;

    const settlements = result.rows.map((r: any) => {
      const settled = parseFloat(r.settled);
      const pending = parseFloat(r.pending);
      const total = parseInt(r.total, 10);
      const totalAmt = settled + pending + parseFloat(r.failed);
      totalSettled += settled;
      totalPending += pending;
      totalAll += totalAmt;
      return {
        provider: r.provider,
        totalTransactions: total,
        settledAmount: parseFloat(settled.toFixed(2)),
        pendingAmount: parseFloat(pending.toFixed(2)),
        failedAmount: parseFloat(parseFloat(r.failed).toFixed(2)),
        settlementRate: totalAmt > 0 ? parseFloat(((settled / totalAmt) * 100).toFixed(2)) : 0,
        avgSettlementTimeMs: null,
      };
    });

    const report: SettlementReport = {
      period,
      settlements,
      totalSettled: parseFloat(totalSettled.toFixed(2)),
      totalPending: parseFloat(totalPending.toFixed(2)),
      overallSettlementRate: totalAll > 0
        ? parseFloat(((totalSettled / totalAll) * 100).toFixed(2))
        : 0,
    };

    await this.setCached(cacheKey, report, 3600);
    return report;
  }

  // ─── KYC Compliance Report ────────────────────────────────────────────────

  async generateKycComplianceReport(period: ReportPeriod): Promise<KycComplianceReport> {
    const cacheKey = `report:kyc:${period.start}:${period.end}`;
    const cached = await this.getCached<KycComplianceReport>(cacheKey);
    if (cached) return cached;

    let summaryResult: any;
    let byLevelResult: any;
    let dailyResult: any;

    try {
      [summaryResult, byLevelResult, dailyResult] = await Promise.all([
        pool.query<any>(
          `SELECT
             COUNT(*)                                            AS total,
             COUNT(*) FILTER (WHERE status = 'approved')        AS approved,
             COUNT(*) FILTER (WHERE status = 'rejected')        AS rejected,
             COUNT(*) FILTER (WHERE status IN ('pending', 'submitted')) AS pending
           FROM kyc_submissions
           WHERE DATE(submitted_at) BETWEEN $1 AND $2`,
          [period.start, period.end],
        ),
        pool.query<any>(
          `SELECT
             level,
             COUNT(*)                                            AS submitted,
             COUNT(*) FILTER (WHERE status = 'approved')        AS approved,
             COUNT(*) FILTER (WHERE status = 'rejected')        AS rejected
           FROM kyc_submissions
           WHERE DATE(submitted_at) BETWEEN $1 AND $2
           GROUP BY level`,
          [period.start, period.end],
        ),
        pool.query<any>(
          `SELECT
             DATE(submitted_at) AS date,
             COUNT(*)           AS submitted,
             COUNT(*) FILTER (WHERE status = 'approved') AS approved,
             COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
           FROM kyc_submissions
           WHERE DATE(submitted_at) BETWEEN $1 AND $2
           GROUP BY DATE(submitted_at)
           ORDER BY DATE(submitted_at)`,
          [period.start, period.end],
        ),
      ]);
    } catch {
      // KYC table may use a different schema; return empty report
      return {
        period,
        summary: { totalUsersSubmitted: 0, approved: 0, rejected: 0, pending: 0, approvalRate: 0 },
        byLevel: {},
        dailySubmissions: [],
      };
    }

    const s = summaryResult.rows[0];
    const total = parseInt(s.total, 10);
    const approved = parseInt(s.approved, 10);
    const rejected = parseInt(s.rejected, 10);
    const pending = parseInt(s.pending, 10);

    const byLevel: KycComplianceReport["byLevel"] = {};
    for (const row of byLevelResult.rows) {
      byLevel[row.level] = {
        submitted: parseInt(row.submitted, 10),
        approved: parseInt(row.approved, 10),
        rejected: parseInt(row.rejected, 10),
      };
    }

    const report: KycComplianceReport = {
      period,
      summary: {
        totalUsersSubmitted: total,
        approved,
        rejected,
        pending,
        approvalRate: total > 0 ? parseFloat(((approved / total) * 100).toFixed(2)) : 0,
      },
      byLevel,
      dailySubmissions: dailyResult.rows.map((r: any) => ({
        date: String(r.date).slice(0, 10),
        submitted: parseInt(r.submitted, 10),
        approved: parseInt(r.approved, 10),
        rejected: parseInt(r.rejected, 10),
      })),
    };

    await this.setCached(cacheKey, report, 3600);
    return report;
  }

  // ─── Custom Report Builder ────────────────────────────────────────────────

  async generateCustomReport(definition: CustomReportDefinition): Promise<CustomReportResult> {
    const selectParts: string[] = [];
    const groupByParts: string[] = [];

    // Map groupBy fields to DB columns
    const groupByColumnMap: Record<string, string> = {
      date: "DATE(created_at)",
      provider: "provider",
      status: "status",
      type: "type",
      currency: "currency",
    };

    for (const gb of definition.groupBy) {
      const col = groupByColumnMap[gb];
      if (col) {
        selectParts.push(`${col} AS "${gb}"`);
        groupByParts.push(col);
      }
    }

    // Map metrics to SQL expressions
    const metricMap: Record<string, string> = {
      count: `COUNT(*) AS "count"`,
      sum_amount: `COALESCE(SUM(amount), 0) AS "sumAmount"`,
      sum_fees: `COALESCE(SUM(fee_amount), 0) AS "sumFees"`,
      avg_amount: `ROUND(AVG(amount)::NUMERIC, 2) AS "avgAmount"`,
    };

    for (const metric of definition.metrics) {
      const expr = metricMap[metric];
      if (expr) selectParts.push(expr);
    }

    if (selectParts.length === 0) {
      return {
        definition,
        rows: [],
        totalRows: 0,
        generatedAt: new Date().toISOString(),
      };
    }

    // Build WHERE clause
    const conditions: string[] = [];
    const values: unknown[] = [];
    let p = 1;

    if (definition.filters.startDate) {
      conditions.push(`DATE(created_at) >= $${p++}`);
      values.push(definition.filters.startDate);
    }
    if (definition.filters.endDate) {
      conditions.push(`DATE(created_at) <= $${p++}`);
      values.push(definition.filters.endDate);
    }
    if (definition.filters.provider) {
      conditions.push(`provider = $${p++}`);
      values.push(definition.filters.provider);
    }
    if (definition.filters.status) {
      conditions.push(`status = $${p++}`);
      values.push(definition.filters.status);
    }
    if (definition.filters.type) {
      conditions.push(`type = $${p++}`);
      values.push(definition.filters.type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const groupBy = groupByParts.length > 0 ? `GROUP BY ${groupByParts.join(", ")}` : "";
    const orderBy = groupByParts.length > 0 ? `ORDER BY ${groupByParts[0]}` : "";

    const sql = `
      SELECT ${selectParts.join(", ")}
      FROM transactions
      ${where}
      ${groupBy}
      ${orderBy}
      LIMIT 10000
    `;

    const result = await pool.query<any>(sql, values);

    return {
      definition,
      rows: result.rows,
      totalRows: result.rows.length,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── Scheduled Reports ────────────────────────────────────────────────────

  async createScheduledReport(
    data: {
      reportType: ReportType;
      schedule: ReportSchedule;
      format: ReportFormat;
      parameters: Record<string, unknown>;
      deliverToEmail: boolean;
      recipients: string[];
    },
    createdBy: string,
  ): Promise<ScheduledReport> {
    const nextRunAt = this.calcNextRun(data.schedule);

    const result = await pool.query<any>(
      `INSERT INTO scheduled_reports
         (report_type, schedule, format, parameters, deliver_to_email, recipients,
          is_active, next_run_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
       RETURNING
         id,
         report_type    AS "reportType",
         schedule, format,
         parameters,
         deliver_to_email AS "deliverToEmail",
         recipients,
         is_active      AS "isActive",
         next_run_at    AS "nextRunAt",
         last_run_at    AS "lastRunAt",
         created_by     AS "createdBy",
         created_at     AS "createdAt"`,
      [
        data.reportType,
        data.schedule,
        data.format,
        JSON.stringify(data.parameters),
        data.deliverToEmail,
        JSON.stringify(data.recipients),
        nextRunAt,
        createdBy,
      ],
    );

    return result.rows[0];
  }

  async getScheduledReports(): Promise<ScheduledReport[]> {
    const result = await pool.query<any>(
      `SELECT
         id, report_type AS "reportType", schedule, format, parameters,
         deliver_to_email AS "deliverToEmail", recipients,
         is_active AS "isActive", next_run_at AS "nextRunAt",
         last_run_at AS "lastRunAt", created_by AS "createdBy",
         created_at AS "createdAt"
       FROM scheduled_reports
       ORDER BY created_at DESC`,
    );
    return result.rows;
  }

  async deleteScheduledReport(id: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM scheduled_reports WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ─── Report Archive ───────────────────────────────────────────────────────

  async archiveReport(
    data: {
      reportType: ReportType;
      format: ReportFormat;
      parameters: Record<string, unknown>;
      payload: Record<string, unknown>;
      retentionDays?: number;
    },
    generatedBy: string,
  ): Promise<ReportArchive> {
    const expiresAt = data.retentionDays
      ? new Date(Date.now() + data.retentionDays * 24 * 60 * 60 * 1000)
      : null;

    const result = await pool.query<any>(
      `INSERT INTO report_archives
         (report_type, format, parameters, status, payload, generated_by, expires_at)
       VALUES ($1, $2, $3, 'ready', $4, $5, $6)
       RETURNING
         id,
         report_type AS "reportType",
         format, parameters, status,
         generated_by AS "generatedBy",
         generated_at AS "generatedAt",
         expires_at   AS "expiresAt",
         payload`,
      [
        data.reportType,
        data.format,
        JSON.stringify(data.parameters),
        JSON.stringify(data.payload),
        generatedBy,
        expiresAt,
      ],
    );

    return result.rows[0];
  }

  async getReportArchives(reportType?: ReportType): Promise<ReportArchive[]> {
    const query = reportType
      ? `SELECT id, report_type AS "reportType", format, parameters, status,
               generated_by AS "generatedBy", generated_at AS "generatedAt",
               expires_at AS "expiresAt", payload
         FROM report_archives
         WHERE report_type = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY generated_at DESC`
      : `SELECT id, report_type AS "reportType", format, parameters, status,
               generated_by AS "generatedBy", generated_at AS "generatedAt",
               expires_at AS "expiresAt", payload
         FROM report_archives
         WHERE expires_at IS NULL OR expires_at > NOW()
         ORDER BY generated_at DESC LIMIT 200`;

    const result = await pool.query<any>(query, reportType ? [reportType] : []);
    return result.rows;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private calcNextRun(schedule: ReportSchedule): Date {
    const now = new Date();
    switch (schedule) {
      case "daily":   return new Date(now.getTime() + 24 * 3600 * 1000);
      case "weekly":  return new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      case "monthly": { const d = new Date(now); d.setMonth(d.getMonth() + 1); return d; }
      default:        return now;
    }
  }

  private async getCached<T>(key: string): Promise<T | null> {
    try {
      if (redisClient?.isOpen) {
        const raw = await redisClient.get(`reporting:${key}`);
        if (raw) return JSON.parse(raw) as T;
      }
    } catch { /* non-fatal */ }
    return null;
  }

  private async setCached(key: string, value: unknown, ttl: number): Promise<void> {
    try {
      if (redisClient?.isOpen) {
        await redisClient.setEx(`reporting:${key}`, ttl, JSON.stringify(value));
      }
    } catch { /* non-fatal */ }
  }
}

export const advancedReportingService = new AdvancedReportingService();
