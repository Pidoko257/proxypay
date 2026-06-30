import { pool } from "../config/database";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AmlRuleType = "amount_threshold" | "velocity_check" | "blacklisted_phone";

/**
 * A single rule evaluation result that gets persisted to aml_screening_results.
 */
export interface AmlScreeningResult {
  id: string;
  transactionId: string;
  ruleId: string;
  ruleName: string;
  ruleType: AmlRuleType;
  triggered: boolean;
  /** Free-form details: observed values, thresholds, velocity counters, etc. */
  details: Record<string, unknown>;
  screenedAt: Date;
}

export interface CreateAmlScreeningResultInput {
  transactionId: string;
  ruleId: string;
  ruleName: string;
  ruleType: AmlRuleType;
  triggered: boolean;
  details?: Record<string, unknown>;
}

export interface AmlScreeningResultFilter {
  transactionId?: string;
  triggered?: boolean;
  limit?: number;
  offset?: number;
}

// ─── Model ───────────────────────────────────────────────────────────────────

export class AmlScreeningResultModel {
  /**
   * Insert a single screening result row.
   */
  async create(input: CreateAmlScreeningResultInput): Promise<AmlScreeningResult> {
    const query = `
      INSERT INTO aml_screening_results (
        transaction_id,
        rule_id,
        rule_name,
        rule_type,
        triggered,
        details
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING
        id,
        transaction_id  AS "transactionId",
        rule_id         AS "ruleId",
        rule_name       AS "ruleName",
        rule_type       AS "ruleType",
        triggered,
        details,
        screened_at     AS "screenedAt"
    `;

    const result = await pool.query(query, [
      input.transactionId,
      input.ruleId,
      input.ruleName,
      input.ruleType,
      input.triggered,
      JSON.stringify(input.details ?? {}),
    ]);

    return this.mapRow(result.rows[0]);
  }

  /**
   * Bulk-insert multiple screening results in a single statement for efficiency.
   */
  async createBulk(inputs: CreateAmlScreeningResultInput[]): Promise<AmlScreeningResult[]> {
    if (inputs.length === 0) return [];

    const values: unknown[] = [];
    const placeholders = inputs.map((input, i) => {
      const base = i * 6;
      values.push(
        input.transactionId,
        input.ruleId,
        input.ruleName,
        input.ruleType,
        input.triggered,
        JSON.stringify(input.details ?? {}),
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });

    const query = `
      INSERT INTO aml_screening_results (
        transaction_id, rule_id, rule_name, rule_type, triggered, details
      )
      VALUES ${placeholders.join(", ")}
      RETURNING
        id,
        transaction_id  AS "transactionId",
        rule_id         AS "ruleId",
        rule_name       AS "ruleName",
        rule_type       AS "ruleType",
        triggered,
        details,
        screened_at     AS "screenedAt"
    `;

    const result = await pool.query(query, values);
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Retrieve all screening results for a given transaction.
   */
  async findByTransactionId(transactionId: string): Promise<AmlScreeningResult[]> {
    const query = `
      SELECT
        id,
        transaction_id  AS "transactionId",
        rule_id         AS "ruleId",
        rule_name       AS "ruleName",
        rule_type       AS "ruleType",
        triggered,
        details,
        screened_at     AS "screenedAt"
      FROM aml_screening_results
      WHERE transaction_id = $1
      ORDER BY screened_at ASC
    `;

    const result = await pool.query(query, [transactionId]);
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Retrieve only the triggered results for a transaction (the rule matches).
   */
  async findTriggeredByTransactionId(transactionId: string): Promise<AmlScreeningResult[]> {
    const query = `
      SELECT
        id,
        transaction_id  AS "transactionId",
        rule_id         AS "ruleId",
        rule_name       AS "ruleName",
        rule_type       AS "ruleType",
        triggered,
        details,
        screened_at     AS "screenedAt"
      FROM aml_screening_results
      WHERE transaction_id = $1
        AND triggered = TRUE
      ORDER BY screened_at ASC
    `;

    const result = await pool.query(query, [transactionId]);
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * List screening results with optional filtering and pagination.
   */
  async list(filter: AmlScreeningResultFilter = {}): Promise<{
    results: AmlScreeningResult[];
    total: number;
  }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter.transactionId !== undefined) {
      conditions.push(`transaction_id = $${idx++}`);
      params.push(filter.transactionId);
    }

    if (filter.triggered !== undefined) {
      conditions.push(`triggered = $${idx++}`);
      params.push(filter.triggered);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await pool.query(
      `SELECT COUNT(*) AS count FROM aml_screening_results ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    const dataResult = await pool.query(
      `SELECT
         id,
         transaction_id  AS "transactionId",
         rule_id         AS "ruleId",
         rule_name       AS "ruleName",
         rule_type       AS "ruleType",
         triggered,
         details,
         screened_at     AS "screenedAt"
       FROM aml_screening_results
       ${where}
       ORDER BY screened_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return {
      results: dataResult.rows.map((row) => this.mapRow(row)),
      total,
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private mapRow(row: Record<string, unknown>): AmlScreeningResult {
    return {
      id: row.id as string,
      transactionId: row.transactionId as string,
      ruleId: row.ruleId as string,
      ruleName: row.ruleName as string,
      ruleType: row.ruleType as AmlRuleType,
      triggered: row.triggered as boolean,
      details: (row.details ?? {}) as Record<string, unknown>,
      screenedAt: row.screenedAt instanceof Date
        ? row.screenedAt
        : new Date(row.screenedAt as string),
    };
  }
}
