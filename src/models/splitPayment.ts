import { queryRead, queryWrite } from "../config/database";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SplitPaymentRule {
  id: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  recipients?: SplitPaymentRecipient[];
}

export interface SplitPaymentRecipient {
  id: string;
  ruleId: string;
  recipientType: "user" | "merchant" | "phone";
  recipientId: string;
  recipientLabel: string | null;
  splitType: "percentage" | "fixed";
  splitValue: number;
  priority: number;
  createdAt: Date;
}

export interface SplitPaymentLedgerEntry {
  id: string;
  transactionId: string;
  ruleId: string | null;
  recipientType: string;
  recipientId: string;
  recipientLabel: string | null;
  splitType: string;
  allocatedAmount: number;
  currency: string;
  status: "pending" | "processing" | "completed" | "failed";
  processedAt: Date | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRecipientInput {
  recipientType: "user" | "merchant" | "phone";
  recipientId: string;
  recipientLabel?: string;
  splitType: "percentage" | "fixed";
  splitValue: number;
  priority?: number;
}

export interface CreateLedgerEntryInput {
  recipientType: string;
  recipientId: string;
  recipientLabel?: string;
  splitType: string;
  allocatedAmount: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface ListRulesOptions {
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

export interface UpdateRuleInput {
  name?: string;
  description?: string;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export class SplitPaymentModel {
  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------

  /** Create a new split payment rule along with its recipients (in a transaction). */
  async createRule(
    name: string,
    description: string | null,
    recipients: CreateRecipientInput[],
    createdBy: string | null,
  ): Promise<SplitPaymentRule> {
    // Use a write connection so both inserts share the same transaction semantics.
    const ruleResult = await queryWrite<SplitPaymentRule>(
      `INSERT INTO split_payment_rules (name, description, created_by)
       VALUES ($1, $2, $3)
       RETURNING
         id,
         name,
         description,
         created_by    AS "createdBy",
         is_active     AS "isActive",
         created_at    AS "createdAt",
         updated_at    AS "updatedAt"`,
      [name, description ?? null, createdBy ?? null],
    );

    const rule = ruleResult.rows[0];

    // Insert all recipients
    const insertedRecipients: SplitPaymentRecipient[] = [];
    for (const r of recipients) {
      const recipientResult = await queryWrite<SplitPaymentRecipient>(
        `INSERT INTO split_payment_recipients
           (rule_id, recipient_type, recipient_id, recipient_label, split_type, split_value, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING
           id,
           rule_id          AS "ruleId",
           recipient_type   AS "recipientType",
           recipient_id     AS "recipientId",
           recipient_label  AS "recipientLabel",
           split_type       AS "splitType",
           split_value      AS "splitValue",
           priority,
           created_at       AS "createdAt"`,
        [
          rule.id,
          r.recipientType,
          r.recipientId,
          r.recipientLabel ?? null,
          r.splitType,
          r.splitValue,
          r.priority ?? 0,
        ],
      );
      insertedRecipients.push({
        ...recipientResult.rows[0],
        splitValue: parseFloat(recipientResult.rows[0].splitValue as unknown as string),
      });
    }

    return { ...rule, recipients: insertedRecipients };
  }

  /** Find a rule by its ID including its recipients. */
  async findRuleById(id: string): Promise<SplitPaymentRule | null> {
    const ruleResult = await queryRead<SplitPaymentRule>(
      `SELECT
         id,
         name,
         description,
         created_by    AS "createdBy",
         is_active     AS "isActive",
         created_at    AS "createdAt",
         updated_at    AS "updatedAt"
       FROM split_payment_rules
       WHERE id = $1`,
      [id],
    );

    const rule = ruleResult.rows[0];
    if (!rule) return null;

    const recipientsResult = await queryRead<SplitPaymentRecipient>(
      `SELECT
         id,
         rule_id          AS "ruleId",
         recipient_type   AS "recipientType",
         recipient_id     AS "recipientId",
         recipient_label  AS "recipientLabel",
         split_type       AS "splitType",
         split_value      AS "splitValue",
         priority,
         created_at       AS "createdAt"
       FROM split_payment_recipients
       WHERE rule_id = $1
       ORDER BY priority ASC, created_at ASC`,
      [id],
    );

    return {
      ...rule,
      recipients: recipientsResult.rows.map((r) => ({
        ...r,
        splitValue: parseFloat(r.splitValue as unknown as string),
      })),
    };
  }

  /** List rules with optional filtering. */
  async listRules(options: ListRulesOptions = {}): Promise<SplitPaymentRule[]> {
    const { isActive, limit = 50, offset = 0 } = options;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (isActive !== undefined) {
      conditions.push(`is_active = $${paramIdx++}`);
      params.push(isActive);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    params.push(offset);

    const result = await queryRead<SplitPaymentRule>(
      `SELECT
         id,
         name,
         description,
         created_by    AS "createdBy",
         is_active     AS "isActive",
         created_at    AS "createdAt",
         updated_at    AS "updatedAt"
       FROM split_payment_rules
       ${where}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params,
    );

    return result.rows;
  }

  /** Update a rule's metadata fields. Recipients are not changed here. */
  async updateRule(id: string, updates: UpdateRuleInput): Promise<SplitPaymentRule | null> {
    const setParts: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [id];
    let paramIdx = 2;

    if (updates.name !== undefined) {
      setParts.push(`name = $${paramIdx++}`);
      params.push(updates.name);
    }
    if (updates.description !== undefined) {
      setParts.push(`description = $${paramIdx++}`);
      params.push(updates.description);
    }
    if (updates.isActive !== undefined) {
      setParts.push(`is_active = $${paramIdx++}`);
      params.push(updates.isActive);
    }

    if (setParts.length === 1) {
      // Only "updated_at = NOW()" — nothing to update
      return this.findRuleById(id);
    }

    const result = await queryWrite<SplitPaymentRule>(
      `UPDATE split_payment_rules
       SET ${setParts.join(", ")}
       WHERE id = $1
       RETURNING
         id,
         name,
         description,
         created_by    AS "createdBy",
         is_active     AS "isActive",
         created_at    AS "createdAt",
         updated_at    AS "updatedAt"`,
      params,
    );

    return result.rows[0] ?? null;
  }

  /** Soft-delete a rule by marking it inactive. */
  async deleteRule(id: string): Promise<SplitPaymentRule | null> {
    const result = await queryWrite<SplitPaymentRule>(
      `UPDATE split_payment_rules
       SET is_active = false, updated_at = NOW()
       WHERE id = $1
       RETURNING
         id,
         name,
         description,
         created_by    AS "createdBy",
         is_active     AS "isActive",
         created_at    AS "createdAt",
         updated_at    AS "updatedAt"`,
      [id],
    );

    return result.rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Ledger
  // -------------------------------------------------------------------------

  /** Create ledger entries for a transaction applying a given rule. */
  async createLedgerEntries(
    transactionId: string,
    ruleId: string | null,
    allocations: CreateLedgerEntryInput[],
  ): Promise<SplitPaymentLedgerEntry[]> {
    const entries: SplitPaymentLedgerEntry[] = [];

    for (const alloc of allocations) {
      const result = await queryWrite<SplitPaymentLedgerEntry>(
        `INSERT INTO split_payment_ledger
           (transaction_id, rule_id, recipient_type, recipient_id, recipient_label,
            split_type, allocated_amount, currency, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING
           id,
           transaction_id   AS "transactionId",
           rule_id          AS "ruleId",
           recipient_type   AS "recipientType",
           recipient_id     AS "recipientId",
           recipient_label  AS "recipientLabel",
           split_type       AS "splitType",
           allocated_amount AS "allocatedAmount",
           currency,
           status,
           processed_at     AS "processedAt",
           error_message    AS "errorMessage",
           metadata,
           created_at       AS "createdAt",
           updated_at       AS "updatedAt"`,
        [
          transactionId,
          ruleId ?? null,
          alloc.recipientType,
          alloc.recipientId,
          alloc.recipientLabel ?? null,
          alloc.splitType,
          alloc.allocatedAmount,
          alloc.currency ?? "XAF",
          JSON.stringify(alloc.metadata ?? {}),
        ],
      );

      const entry = result.rows[0];
      entries.push({
        ...entry,
        allocatedAmount: parseFloat(entry.allocatedAmount as unknown as string),
      });
    }

    return entries;
  }

  /** Get all ledger entries for a specific transaction. */
  async getLedgerForTransaction(transactionId: string): Promise<SplitPaymentLedgerEntry[]> {
    const result = await queryRead<SplitPaymentLedgerEntry>(
      `SELECT
         id,
         transaction_id   AS "transactionId",
         rule_id          AS "ruleId",
         recipient_type   AS "recipientType",
         recipient_id     AS "recipientId",
         recipient_label  AS "recipientLabel",
         split_type       AS "splitType",
         allocated_amount AS "allocatedAmount",
         currency,
         status,
         processed_at     AS "processedAt",
         error_message    AS "errorMessage",
         metadata,
         created_at       AS "createdAt",
         updated_at       AS "updatedAt"
       FROM split_payment_ledger
       WHERE transaction_id = $1
       ORDER BY created_at ASC`,
      [transactionId],
    );

    return result.rows.map((r) => ({
      ...r,
      allocatedAmount: parseFloat(r.allocatedAmount as unknown as string),
    }));
  }

  /** Update the status of a single ledger entry. */
  async updateLedgerEntryStatus(
    id: string,
    status: SplitPaymentLedgerEntry["status"],
    errorMessage?: string,
  ): Promise<SplitPaymentLedgerEntry | null> {
    const result = await queryWrite<SplitPaymentLedgerEntry>(
      `UPDATE split_payment_ledger
       SET status        = $2,
           processed_at  = CASE WHEN $2 IN ('completed', 'failed') THEN NOW() ELSE processed_at END,
           error_message = $3,
           updated_at    = NOW()
       WHERE id = $1
       RETURNING
         id,
         transaction_id   AS "transactionId",
         rule_id          AS "ruleId",
         recipient_type   AS "recipientType",
         recipient_id     AS "recipientId",
         recipient_label  AS "recipientLabel",
         split_type       AS "splitType",
         allocated_amount AS "allocatedAmount",
         currency,
         status,
         processed_at     AS "processedAt",
         error_message    AS "errorMessage",
         metadata,
         created_at       AS "createdAt",
         updated_at       AS "updatedAt"`,
      [id, status, errorMessage ?? null],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      ...row,
      allocatedAmount: parseFloat(row.allocatedAmount as unknown as string),
    };
  }
}
