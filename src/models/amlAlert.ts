import { pool } from "../config/database";
import {
  CursorPayload,
  buildCursorWhere,
  decodeCursor,
} from "../utils/pagination";
import {
  AMLAlert,
  AMLAlertStatus,
  AMLAlertSeverity,
  AMLRuleHit,
  AMLReviewInput,
} from "../services/aml";

export interface AMLAlertFilter {
  status?: AMLAlertStatus;
  userId?: string;
  severity?: AMLAlertSeverity;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
  before?: string;
  after?: string;
}

export interface AMLAlertListResult {
  alerts: AMLAlert[];
  total: number;
  pendingReview: number;
  hasMore?: boolean;
}

export interface AMLReviewHistoryEntry {
  id: string;
  alertId: string;
  previousStatus: string;
  newStatus: string;
  reviewedBy: string;
  reviewNotes?: string;
  createdAt: string;
}

export class AMLAlertModel {
  async create(alert: Omit<AMLAlert, "updatedAt">): Promise<AMLAlert> {
    const query = `
      INSERT INTO aml_alerts (
        id, transaction_id, user_id, severity, status,
        rule_hits, reasons, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        id,
        transaction_id AS "transactionId",
        user_id AS "userId",
        severity,
        status,
        rule_hits AS "ruleHits",
        reasons,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        reviewed_at AS "reviewedAt",
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes"
    `;

    const result = await pool.query(query, [
      alert.id,
      alert.transactionId,
      alert.userId,
      alert.severity,
      alert.status,
      JSON.stringify(alert.ruleHits),
      alert.reasons,
      alert.createdAt,
    ]);

    return this.mapRow(result.rows[0]);
  }

  /**
   * Return every alert matching the filter (no pagination), newest first.
   * Used for compliance reporting and SAR collation where a truncated set
   * would be incorrect.
   */
  async findAll(
    filter: Pick<AMLAlertFilter, "status" | "userId" | "severity" | "startDate" | "endDate"> = {},
  ): Promise<AMLAlert[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.userId) {
      params.push(filter.userId);
      conditions.push(`user_id = $${params.length}`);
    }
    if (filter.severity) {
      params.push(filter.severity);
      conditions.push(`severity = $${params.length}`);
    }
    if (filter.startDate) {
      params.push(filter.startDate);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter.endDate) {
      params.push(filter.endDate);
      conditions.push(`created_at <= $${params.length}`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const query = `
      SELECT
        id,
        transaction_id AS "transactionId",
        user_id AS "userId",
        severity,
        status,
        rule_hits AS "ruleHits",
        reasons,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        reviewed_at AS "reviewedAt",
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes"
      FROM aml_alerts
      ${whereClause}
      ORDER BY created_at DESC, id DESC
    `;

    const result = await pool.query(query, params);
    return result.rows.map((row) => this.mapRow(row));
  }

  async findById(id: string): Promise<AMLAlert | null> {
    const query = `
      SELECT
        id,
        transaction_id AS "transactionId",
        user_id AS "userId",
        severity,
        status,
        rule_hits AS "ruleHits",
        reasons,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        reviewed_at AS "reviewedAt",
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes"
      FROM aml_alerts
      WHERE id = $1
    `;

    const result = await pool.query(query, [id]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async list(filter: AMLAlertFilter = {}): Promise<AMLAlertListResult> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filter.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filter.status);
    }

    if (filter.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(filter.userId);
    }

    if (filter.severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(filter.severity);
    }

    if (filter.startDate) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(filter.startDate);
    }

    if (filter.endDate) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(filter.endDate);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM aml_alerts ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count, 10);

    // Get pending review count
    const pendingQuery = `
      SELECT COUNT(*) as count 
      FROM aml_alerts 
      ${whereClause ? whereClause + " AND" : "WHERE"} status = 'pending_review'
    `;
    const pendingResult = await pool.query(pendingQuery, params);
    const pendingReview = parseInt(pendingResult.rows[0].count, 10);

    // Keyset pagination processing
    let cursorPayload: CursorPayload | null = null;
    let isReversed = false;

    if (filter.after) {
      cursorPayload = decodeCursor(filter.after);
    } else if (filter.before) {
      cursorPayload = decodeCursor(filter.before);
      isReversed = true;
    }

    // Build conditions including keyset cursor
    const alertsConditions = [...conditions];
    const alertsParams = [...params];
    let alertsParamIndex = paramIndex;

    if (cursorPayload) {
      const { clause, params: cursorParams } = buildCursorWhere(cursorPayload, {
        column: "created_at",
        idColumn: "id",
        order: "desc",
        direction: isReversed ? "backward" : "forward",
        paramOffset: alertsParamIndex,
      });
      alertsConditions.push(clause);
      alertsParams.push(...cursorParams);
      alertsParamIndex += cursorParams.length;
    }

    const alertsWhereClause =
      alertsConditions.length > 0 ? `WHERE ${alertsConditions.join(" AND ")}` : "";

    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
    const isCursorPagination = !!(filter.before || filter.after);
    const sortOrder = isReversed ? "ASC" : "DESC";

    let alertsQuery = "";
    let alertsResult;

    if (isCursorPagination) {
      alertsQuery = `
        SELECT
          id,
          transaction_id AS "transactionId",
          user_id AS "userId",
          severity,
          status,
          rule_hits AS "ruleHits",
          reasons,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          reviewed_at AS "reviewedAt",
          reviewed_by AS "reviewedBy",
          review_notes AS "reviewNotes"
        FROM aml_alerts
        ${alertsWhereClause}
        ORDER BY created_at ${sortOrder}, id ${sortOrder}
        LIMIT $${alertsParamIndex++}
      `;
      alertsResult = await pool.query(alertsQuery, [...alertsParams, limit + 1]);
    } else {
      const offset = filter.offset ?? 0;
      alertsQuery = `
        SELECT
          id,
          transaction_id AS "transactionId",
          user_id AS "userId",
          severity,
          status,
          rule_hits AS "ruleHits",
          reasons,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          reviewed_at AS "reviewedAt",
          reviewed_by AS "reviewedBy",
          review_notes AS "reviewNotes"
        FROM aml_alerts
        ${alertsWhereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT $${alertsParamIndex++} OFFSET $${alertsParamIndex++}
      `;
      alertsResult = await pool.query(alertsQuery, [...alertsParams, limit, offset]);
    }

    let alerts = alertsResult.rows.map((row) => this.mapRow(row));
    let hasMore = false;

    if (isCursorPagination) {
      if (alerts.length > limit) {
        hasMore = true;
        alerts = alerts.slice(0, limit);
      }
      if (isReversed) {
        alerts.reverse();
      }
    } else {
      const offset = filter.offset ?? 0;
      hasMore = offset + limit < total;
    }

    return { alerts, total, pendingReview, hasMore };
  }

  async review(
    alertId: string,
    input: AMLReviewInput,
    reviewerId: string,
  ): Promise<AMLAlert | null> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Get current alert
      const currentQuery = `
        SELECT status FROM aml_alerts WHERE id = $1 FOR UPDATE
      `;
      const currentResult = await client.query(currentQuery, [alertId]);

      if (currentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }

      const previousStatus = currentResult.rows[0].status;

      // Update alert
      const updateQuery = `
        UPDATE aml_alerts
        SET
          status = $1,
          reviewed_by = $2,
          review_notes = $3,
          reviewed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING
          id,
          transaction_id AS "transactionId",
          user_id AS "userId",
          severity,
          status,
          rule_hits AS "ruleHits",
          reasons,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          reviewed_at AS "reviewedAt",
          reviewed_by AS "reviewedBy",
          review_notes AS "reviewNotes"
      `;

      const updateResult = await client.query(updateQuery, [
        input.status,
        reviewerId,
        input.reviewNotes || null,
        alertId,
      ]);

      // Record in review history
      const historyQuery = `
        INSERT INTO aml_alert_review_history (
          alert_id, previous_status, new_status, reviewed_by, review_notes
        )
        VALUES ($1, $2, $3, $4, $5)
      `;

      await client.query(historyQuery, [
        alertId,
        previousStatus,
        input.status,
        reviewerId,
        input.reviewNotes || null,
      ]);

      await client.query("COMMIT");

      return this.mapRow(updateResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Persist an escalation of an existing alert (e.g. a sanction match added
   * after the rule-based evaluation already stored the alert).
   */
  async updateEscalation(
    alertId: string,
    update: Pick<AMLAlert, "severity" | "ruleHits" | "reasons">,
  ): Promise<AMLAlert | null> {
    const query = `
      UPDATE aml_alerts
      SET
        severity = $1,
        rule_hits = $2,
        reasons = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING
        id,
        transaction_id AS "transactionId",
        user_id AS "userId",
        severity,
        status,
        rule_hits AS "ruleHits",
        reasons,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        reviewed_at AS "reviewedAt",
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes"
    `;

    const result = await pool.query(query, [
      update.severity,
      JSON.stringify(update.ruleHits),
      update.reasons,
      alertId,
    ]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async getReviewHistory(alertId: string): Promise<AMLReviewHistoryEntry[]> {
    const query = `
      SELECT
        id,
        alert_id AS "alertId",
        previous_status AS "previousStatus",
        new_status AS "newStatus",
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes",
        created_at AS "createdAt"
      FROM aml_alert_review_history
      WHERE alert_id = $1
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query, [alertId]);
    return result.rows.map((row) => ({
      id: row.id,
      alertId: row.alertId,
      previousStatus: row.previousStatus,
      newStatus: row.newStatus,
      reviewedBy: row.reviewedBy,
      reviewNotes: row.reviewNotes,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async getAlertsByTransaction(
    transactionId: string,
  ): Promise<AMLAlert[]> {
    const query = `
      SELECT
        id,
        transaction_id AS "transactionId",
        user_id AS "userId",
        severity,
        status,
        rule_hits AS "ruleHits",
        reasons,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        reviewed_at AS "reviewedAt",
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes"
      FROM aml_alerts
      WHERE transaction_id = $1
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query, [transactionId]);
    return result.rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: any): AMLAlert {
    return {
      id: row.id,
      transactionId: row.transactionId,
      userId: row.userId,
      severity: row.severity,
      status: row.status,
      ruleHits: row.ruleHits,
      reasons: row.reasons,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : undefined,
      reviewedBy: row.reviewedBy || undefined,
      reviewNotes: row.reviewNotes || undefined,
    };
  }
}
