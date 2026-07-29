import { queryRead, queryWrite, pool } from "../config/database";
import { redis } from "../config/redis";
import { analyticsEventModel, type AnalyticsEvent } from "../models/analyticsEvent";
import logger from "../utils/logger";
import { Decimal } from "decimal.js";

export interface TransactionTrend {
  date: Date;
  count: number;
  volume: Decimal;
  successRate: number;
  avgDuration: number;
}

export interface CohortData {
  cohortId: string;
  cohortName: string;
  created: Date;
  userCount: number;
  retention: {
    day1: number;
    day7: number;
    day30: number;
    day90: number;
  };
}

export interface FunnelStep {
  name: string;
  count: number;
  conversionRate: number;
  avgDuration?: number;
}

export interface FunnelAnalysis {
  funnelName: string;
  steps: FunnelStep[];
  totalEntries: number;
  completionRate: number;
  abandonmentRate: number;
}

/**
 * Comprehensive Analytics Service
 */
export class AnalyticsService {
  /**
   * Log user event
   */
  async logEvent(data: Omit<AnalyticsEvent, "id" | "createdAt" | "eventTimestamp">): Promise<void> {
    try {
      await analyticsEventModel.createEvent(data);
    } catch (error) {
      logger.error("Failed to log analytics event:", error);
      // Don't throw - analytics shouldn't break application
    }
  }

  /**
   * Log multiple events (batch)
   */
  async logEvents(events: Array<Omit<AnalyticsEvent, "id" | "createdAt" | "eventTimestamp">>): Promise<void> {
    try {
      await analyticsEventModel.bulkCreateEvents(events);
    } catch (error) {
      logger.error("Failed to log bulk analytics events:", error);
    }
  }

  /**
   * Get transaction trends for period
   */
  async getTransactionTrends(startDate: Date, endDate: Date): Promise<TransactionTrend[]> {
    const cacheKey = `trends:${startDate.toISOString()}:${endDate.toISOString()}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    const result = await queryRead(
      `SELECT 
         DATE(event_timestamp) as event_date,
         COUNT(*) as transaction_count,
         SUM((properties->>'amount')::DECIMAL) as total_volume,
         COUNT(*) FILTER (WHERE properties->>'status' = 'completed') * 100.0 / COUNT(*) as success_rate,
         AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE NULL END) as avg_duration
       FROM analytics_events
       WHERE event_type IN ('transaction', 'deposit', 'withdraw')
         AND event_timestamp >= $1
         AND event_timestamp < $2
       GROUP BY DATE(event_timestamp)
       ORDER BY event_date DESC`,
      [startDate, endDate],
    );

    const trends = result.rows.map((row) => ({
      date: new Date(row.event_date),
      count: parseInt(row.transaction_count || "0", 10),
      volume: new Decimal(row.total_volume || "0"),
      successRate: parseFloat(row.success_rate || "100"),
      avgDuration: row.avg_duration ? Math.round(row.avg_duration) : 0,
    }));

    // Cache for 1 hour
    await redis.setex(cacheKey, 3600, JSON.stringify(trends));

    return trends;
  }

  /**
   * Get cohort analysis
   */
  async getCohortAnalysis(cohortId?: string): Promise<CohortData[]> {
    let query = `SELECT 
                   c.id, c.cohort_name, c.created_date, 
                   COUNT(DISTINCT cm.user_id) as user_count,
                   c.retention_day_1, c.retention_day_7, c.retention_day_30, c.retention_day_90
                 FROM analytics_cohorts c
                 LEFT JOIN analytics_cohort_members cm ON c.id = cm.cohort_id AND cm.is_active = true
                 WHERE 1=1`;
    const params: any[] = [];

    if (cohortId) {
      query += ` AND c.id = $1`;
      params.push(cohortId);
    }

    query += ` GROUP BY c.id ORDER BY c.created_date DESC LIMIT 100`;

    const result = await queryRead(query, params);

    return result.rows.map((row) => ({
      cohortId: row.id,
      cohortName: row.cohort_name,
      created: new Date(row.created_date),
      userCount: parseInt(row.user_count || "0", 10),
      retention: {
        day1: row.retention_day_1 || 0,
        day7: row.retention_day_7 || 0,
        day30: row.retention_day_30 || 0,
        day90: row.retention_day_90 || 0,
      },
    }));
  }

  /**
   * Create user cohort
   */
  async createCohort(data: { name: string; type: string; definition: any }): Promise<string> {
    const result = await queryWrite(
      `INSERT INTO analytics_cohorts (cohort_name, cohort_type, definition, created_date)
       VALUES ($1, $2, $3, CURRENT_DATE)
       RETURNING id`,
      [data.name, data.type, JSON.stringify(data.definition)],
    );

    return result.rows[0].id;
  }

  /**
   * Get funnel analysis
   */
  async getFunnelAnalysis(funnelId?: string): Promise<FunnelAnalysis[]> {
    let query = `SELECT 
                   f.id, f.funnel_name, f.steps,
                   COUNT(*) FILTER (WHERE fe.status = 'entered') as total_entries,
                   COUNT(*) FILTER (WHERE fe.status = 'completed') as completed_count,
                   JSONB_OBJECT_AGG(fe.step_name, COUNT(*) FILTER (WHERE fe.step_index = fe.step_index)) as step_counts
                 FROM analytics_funnels f
                 LEFT JOIN analytics_funnel_events fe ON f.id = fe.funnel_id
                 WHERE 1=1`;
    const params: any[] = [];

    if (funnelId) {
      query += ` AND f.id = $1`;
      params.push(funnelId);
    }

    query += ` GROUP BY f.id LIMIT 50`;

    const result = await queryRead(query, params);

    return result.rows.map((row) => {
      const steps: FunnelStep[] = [];
      const stepsData = row.steps || [];
      const totalEntries = parseInt(row.total_entries || "0", 10);
      let previousCount = totalEntries;

      stepsData.forEach((step: any, index: number) => {
        const stepName = step.name || `Step ${index + 1}`;
        const currentCount = previousCount;
        const conversionRate = previousCount > 0 ? ((currentCount - (index > 0 ? currentCount : 0)) / previousCount) * 100 : 100;

        steps.push({
          name: stepName,
          count: currentCount,
          conversionRate: Math.max(0, conversionRate),
          avgDuration: step.avgDuration,
        });
      });

      return {
        funnelName: row.funnel_name,
        steps,
        totalEntries,
        completionRate: totalEntries > 0 ? (parseInt(row.completed_count || "0", 10) / totalEntries) * 100 : 0,
        abandonmentRate: totalEntries > 0 ? ((totalEntries - parseInt(row.completed_count || "0", 10)) / totalEntries) * 100 : 0,
      };
    });
  }

  /**
   * Track funnel event
   */
  async trackFunnelEvent(data: {
    funnelId: string;
    userId: string;
    stepIndex: number;
    stepName: string;
    status: "entered" | "completed" | "abandoned";
    reason?: string;
  }): Promise<void> {
    await queryWrite(
      `INSERT INTO analytics_funnel_events (funnel_id, user_id, step_index, step_name, status, abandoned_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [data.funnelId, data.userId, data.stepIndex, data.stepName, data.status, data.reason || null],
    );
  }

  /**
   * Get dashboard summary metrics
   */
  async getDashboardMetrics(period: "today" | "week" | "month" = "today"): Promise<any> {
    const cacheKey = `dashboard:${period}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    let dateFilter = "";
    if (period === "today") {
      dateFilter = `AND DATE(event_timestamp) = CURRENT_DATE`;
    } else if (period === "week") {
      dateFilter = `AND event_timestamp >= CURRENT_DATE - INTERVAL '7 days'`;
    } else if (period === "month") {
      dateFilter = `AND event_timestamp >= CURRENT_DATE - INTERVAL '30 days'`;
    }

    const result = await queryRead(
      `SELECT 
         COUNT(DISTINCT user_id) as active_users,
         COUNT(DISTINCT CASE WHEN event_type = 'login' THEN session_id END) as unique_sessions,
         COUNT(CASE WHEN event_type IN ('transaction', 'deposit', 'withdraw') THEN 1 END) as total_txns,
         COUNT(CASE WHEN event_type IN ('transaction', 'deposit', 'withdraw') AND properties->>'status' = 'completed' THEN 1 END) as successful_txns,
         SUM((CASE WHEN event_type IN ('transaction', 'deposit', 'withdraw') THEN (properties->>'amount')::DECIMAL ELSE 0 END)) as total_volume,
         COUNT(CASE WHEN event_type = 'error' THEN 1 END) as error_count,
         COUNT(CASE WHEN event_type = 'kyc' THEN 1 END) as kyc_events,
         COUNT(DISTINCT country) as countries_active
       FROM analytics_events
       WHERE 1=1 ${dateFilter}`,
      [],
    );

    const row = result.rows[0];
    const metrics = {
      activeUsers: parseInt(row.active_users || "0", 10),
      uniqueSessions: parseInt(row.unique_sessions || "0", 10),
      totalTransactions: parseInt(row.total_txns || "0", 10),
      successfulTransactions: parseInt(row.successful_txns || "0", 10),
      totalVolume: new Decimal(row.total_volume || "0"),
      errorCount: parseInt(row.error_count || "0", 10),
      kycEvents: parseInt(row.kyc_events || "0", 10),
      countriesActive: parseInt(row.countries_active || "0", 10),
      successRate:
        parseInt(row.total_txns || "0", 10) > 0
          ? (parseInt(row.successful_txns || "0", 10) / parseInt(row.total_txns || "0", 10)) * 100
          : 0,
    };

    // Cache for 15 minutes
    await redis.setex(cacheKey, 900, JSON.stringify(metrics));

    return metrics;
  }

  /**
   * Export analytics data
   */
  async exportData(format: "csv" | "json" | "parquet", filters: any): Promise<string> {
    const startDate = filters.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = filters.endDate || new Date();

    const events = await analyticsEventModel.getEventsByDateRange(startDate, endDate, filters.eventType);

    if (format === "json") {
      return JSON.stringify(events, null, 2);
    }

    if (format === "csv") {
      const headers = [
        "Event ID",
        "Event Type",
        "Event Name",
        "User ID",
        "Transaction ID",
        "Platform",
        "Country",
        "Value",
        "Duration (ms)",
        "Timestamp",
      ];

      const rows = events.map((event) => [
        event.eventId,
        event.eventType,
        event.eventName,
        event.userId,
        event.transactionId,
        event.platform,
        event.country,
        event.value,
        event.durationMs,
        event.eventTimestamp.toISOString(),
      ]);

      const csv = [headers, ...rows.map((row) => row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(","))].join("\n");

      return csv;
    }

    // Parquet format would require additional library
    return JSON.stringify(events);
  }

  /**
   * Get user retention curves
   */
  async getUserRetention(startDate: Date, endDate: Date): Promise<any[]> {
    const query = `
      WITH first_login AS (
        SELECT user_id, MIN(DATE(event_timestamp)) as first_login_date
        FROM analytics_events
        WHERE event_type = 'login'
        GROUP BY user_id
      )
      SELECT 
        first_login_date,
        COUNT(DISTINCT fl.user_id) as cohort_size,
        COUNT(DISTINCT CASE WHEN DATE(ae.event_timestamp) = first_login_date THEN ae.user_id END) as day_0,
        COUNT(DISTINCT CASE WHEN DATE(ae.event_timestamp) = first_login_date + INTERVAL '1 day' THEN ae.user_id END) as day_1,
        COUNT(DISTINCT CASE WHEN DATE(ae.event_timestamp) = first_login_date + INTERVAL '7 days' THEN ae.user_id END) as day_7,
        COUNT(DISTINCT CASE WHEN DATE(ae.event_timestamp) = first_login_date + INTERVAL '30 days' THEN ae.user_id END) as day_30
      FROM first_login fl
      LEFT JOIN analytics_events ae ON fl.user_id = ae.user_id AND ae.event_type = 'login'
      WHERE first_login_date >= $1 AND first_login_date < $2
      GROUP BY first_login_date
      ORDER BY first_login_date DESC
    `;

    const result = await queryRead(query, [startDate, endDate]);

    return result.rows.map((row) => ({
      cohortDate: new Date(row.first_login_date),
      cohortSize: parseInt(row.cohort_size || "0", 10),
      retention: {
        day0: parseInt(row.day_0 || "0", 10),
        day1: parseInt(row.day_1 || "0", 10),
        day7: parseInt(row.day_7 || "0", 10),
        day30: parseInt(row.day_30 || "0", 10),
      },
    }));
  }

  /**
   * Refresh materialized views
   */
  async refreshMaterializedViews(): Promise<void> {
    logger.info("[Analytics] Refreshing materialized views");

    try {
      await queryWrite(`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_transaction_daily_stats`, []);
      await queryWrite(`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_user_activity_metrics`, []);
      logger.info("[Analytics] Materialized views refreshed successfully");
    } catch (error) {
      logger.error("[Analytics] Failed to refresh materialized views:", error);
    }
  }

  /**
   * Clean up old events (archival)
   */
  async archiveOldEvents(retentionDays: number = 90): Promise<number> {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const result = await queryWrite(
      `UPDATE analytics_events SET is_archived = true WHERE event_timestamp < $1 AND is_archived = false RETURNING id`,
      [cutoffDate],
    );

    return result.rowCount || 0;
  }
}

export const analyticsService = new AnalyticsService();
