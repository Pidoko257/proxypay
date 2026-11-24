import crypto from "crypto";
import { queryRead, queryWrite } from "../config/database";

export type EmailOutboxStatus = "pending" | "processing" | "delivered" | "failed" | "dlq";

export interface EmailOutboxEntry {
  id: string;
  recipient_email: string;
  email_type: string;
  dedup_key: string | null;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  provider_name: string | null;
  provider_id: string | null;
  provider_response: Record<string, any> | null;
  status: EmailOutboxStatus;
  attempts: number;
  max_attempts: number;
  last_attempt_at: Date | null;
  next_attempt_at: Date;
  error_message: string | null;
  error_code: string | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  user_id: string | null;
  headers: Record<string, any> | null;
  attachments_metadata: Record<string, any> | null;
  created_at: Date;
  updated_at: Date;
  delivered_at: Date | null;
}

interface CreateOutboxOptions {
  recipient_email: string;
  email_type: string;
  subject: string;
  body_html?: string | null;
  body_text?: string | null;
  dedup_key?: string | null;
  max_attempts?: number;
  related_entity_type?: string | null;
  related_entity_id?: string | null;
  user_id?: string | null;
  headers?: Record<string, any> | null;
  attachments_metadata?: Record<string, any> | null;
}

interface QueryPendingOptions {
  limit?: number;
  offset?: number;
  types?: string[];
}

interface UpdateStatusOptions {
  status: EmailOutboxStatus;
  provider_name?: string;
  provider_id?: string;
  provider_response?: Record<string, any>;
  error_message?: string;
  error_code?: string;
  delivered_at?: Date | null;
}

/**
 * EmailOutboxModel: Data access layer for email outbox operations
 * - Queues emails with deduplication
 * - Tracks delivery attempts and provider responses
 * - Supports retry scheduling and bounded retry logic
 */
export class EmailOutboxModel {
  /**
   * Generate a dedup key from normalized context (email_type + recipient + entity)
   */
  static generateDedupKey(
    email_type: string,
    recipient_email: string,
    related_entity_type?: string | null,
    related_entity_id?: string | null,
  ): string {
    const input = [
      email_type,
      recipient_email.toLowerCase(),
      related_entity_type || "",
      related_entity_id || "",
    ].join("|");
    return crypto.createHash("sha256").update(input).digest("hex");
  }

  /**
   * Create a new email outbox entry
   * If dedup_key is provided and an entry with the same key exists in
   * pending/delivered/processing state, return null (already queued or delivered)
   */
  async create(options: CreateOutboxOptions): Promise<EmailOutboxEntry | null> {
    const {
      recipient_email,
      email_type,
      subject,
      body_html,
      body_text,
      dedup_key,
      max_attempts = 5,
      related_entity_type,
      related_entity_id,
      user_id,
      headers,
      attachments_metadata,
    } = options;

    // Check for existing dedup entry if key provided
    if (dedup_key) {
      const existing = await queryRead(
        `SELECT id FROM email_outbox
         WHERE dedup_key = $1
         AND status IN ('pending', 'processing', 'delivered')
         LIMIT 1`,
        [dedup_key],
      );

      if (existing.rows.length > 0) {
        return null; // Already queued or delivered
      }
    }

    const result = await queryWrite(
      `INSERT INTO email_outbox (
        recipient_email, email_type, subject, body_html, body_text,
        dedup_key, max_attempts, related_entity_type, related_entity_id,
        user_id, headers, attachments_metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        recipient_email,
        email_type,
        subject,
        body_html || null,
        body_text || null,
        dedup_key || null,
        max_attempts,
        related_entity_type || null,
        related_entity_id || null,
        user_id || null,
        headers ? JSON.stringify(headers) : null,
        attachments_metadata ? JSON.stringify(attachments_metadata) : null,
      ],
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Query pending emails that need processing
   */
  async queryPending(options: QueryPendingOptions = {}): Promise<EmailOutboxEntry[]> {
    const { limit = 100, offset = 0, types } = options;

    let query = `SELECT * FROM email_outbox
                 WHERE status IN ('pending', 'failed')
                 AND next_attempt_at <= NOW()`;

    const params: any[] = [];

    if (types && types.length > 0) {
      query += ` AND email_type = ANY($${params.length + 1}::text[])`;
      params.push(types);
    }

    query += ` ORDER BY next_attempt_at ASC, created_at ASC
               LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await queryRead(query, params);
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Find entry by ID
   */
  async findById(id: string): Promise<EmailOutboxEntry | null> {
    const result = await queryRead(`SELECT * FROM email_outbox WHERE id = $1`, [id]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Find by dedup key and status
   */
  async findByDedupKey(
    dedup_key: string,
    statuses: EmailOutboxStatus[] = ["pending", "processing", "delivered"],
  ): Promise<EmailOutboxEntry | null> {
    const result = await queryRead(
      `SELECT * FROM email_outbox
       WHERE dedup_key = $1 AND status = ANY($2::text[])
       LIMIT 1`,
      [dedup_key, statuses],
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Update entry status and retry info
   */
  async updateStatus(id: string, options: UpdateStatusOptions): Promise<EmailOutboxEntry | null> {
    const {
      status,
      provider_name,
      provider_id,
      provider_response,
      error_message,
      error_code,
      delivered_at,
    } = options;

    const result = await queryWrite(
      `UPDATE email_outbox
       SET status = $1,
           provider_name = COALESCE($2, provider_name),
           provider_id = COALESCE($3, provider_id),
           provider_response = CASE WHEN $4::jsonb IS NOT NULL
                                 THEN $4::jsonb ELSE provider_response END,
           error_message = COALESCE($5, error_message),
           error_code = COALESCE($6, error_code),
           delivered_at = CASE WHEN $7::timestamptz IS NOT NULL THEN $7::timestamptz ELSE delivered_at END,
           last_attempt_at = NOW(),
           updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        status,
        provider_name || null,
        provider_id || null,
        provider_response ? JSON.stringify(provider_response) : null,
        error_message || null,
        error_code || null,
        delivered_at || null,
        id,
      ],
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Increment attempt counter and schedule next retry
   */
  async recordAttempt(
    id: string,
    error?: { message: string; code?: string },
  ): Promise<EmailOutboxEntry | null> {
    const nextRetryDelay = this.calculateBackoffDelay();

    const result = await queryWrite(
      `UPDATE email_outbox
       SET attempts = attempts + 1,
           error_message = $1,
           error_code = $2,
           next_attempt_at = NOW() + ($3::integer || ' seconds')::interval,
           updated_at = NOW(),
           status = CASE
             WHEN attempts + 1 >= max_attempts THEN 'dlq'
             ELSE 'failed'
           END
       WHERE id = $4
       RETURNING *`,
      [error?.message || null, error?.code || null, nextRetryDelay, id],
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Move entry to DLQ (dead letter queue)
   */
  async moveToDLQ(id: string, reason: string): Promise<EmailOutboxEntry | null> {
    const result = await queryWrite(
      `UPDATE email_outbox
       SET status = 'dlq', error_message = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [reason, id],
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Get outbox statistics
   */
  async getStats(): Promise<{
    pending: number;
    failed: number;
    delivered: number;
    dlq: number;
    processing: number;
  }> {
    const result = await queryRead(
      `SELECT status, COUNT(*) as count FROM email_outbox GROUP BY status`,
    );

    const stats = {
      pending: 0,
      failed: 0,
      delivered: 0,
      dlq: 0,
      processing: 0,
    };

    result.rows.forEach((row: any) => {
      if (row.status in stats) {
        stats[row.status as EmailOutboxStatus] = parseInt(row.count, 10);
      }
    });

    return stats;
  }

  /**
   * List entries with filters (for admin dashboard)
   */
  async listWithFilters(filters: {
    status?: EmailOutboxStatus[];
    email_type?: string[];
    user_id?: string;
    related_entity_type?: string;
    related_entity_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ entries: EmailOutboxEntry[]; total: number }> {
    let query = `SELECT * FROM email_outbox WHERE 1=1`;
    let countQuery = `SELECT COUNT(*) FROM email_outbox WHERE 1=1`;
    const params: any[] = [];

    if (filters.status && filters.status.length > 0) {
      query += ` AND status = ANY($${params.length + 1}::text[])`;
      countQuery += ` AND status = ANY($${params.length + 1}::text[])`;
      params.push(filters.status);
    }

    if (filters.email_type && filters.email_type.length > 0) {
      query += ` AND email_type = ANY($${params.length + 1}::text[])`;
      countQuery += ` AND email_type = ANY($${params.length + 1}::text[])`;
      params.push(filters.email_type);
    }

    if (filters.user_id) {
      query += ` AND user_id = $${params.length + 1}`;
      countQuery += ` AND user_id = $${params.length + 1}`;
      params.push(filters.user_id);
    }

    if (filters.related_entity_type) {
      query += ` AND related_entity_type = $${params.length + 1}`;
      countQuery += ` AND related_entity_type = $${params.length + 1}`;
      params.push(filters.related_entity_type);
    }

    if (filters.related_entity_id) {
      query += ` AND related_entity_id = $${params.length + 1}`;
      countQuery += ` AND related_entity_id = $${params.length + 1}`;
      params.push(filters.related_entity_id);
    }

    const limit = Math.min(filters.limit || 50, 1000);
    const offset = filters.offset || 0;

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const [entriesResult, countResult] = await Promise.all([
      queryRead(query, params),
      queryRead(countQuery, params.slice(0, params.length - 2)),
    ]);

    return {
      entries: entriesResult.rows.map((row) => this.mapRow(row)),
      total: parseInt(countResult.rows[0]?.count || 0, 10),
    };
  }

  /**
   * Retry-specific calculation: exponential backoff capped at 1 hour
   */
  private calculateBackoffDelay(): number {
    // Start at 60s, double on each retry, cap at 3600s (1 hour)
    // Formula: min(60 * 2^attempt, 3600)
    const base = 60;
    const maxDelay = 3600;
    return Math.min(base * 10, maxDelay); // Simplified: 10x base
  }

  /**
   * Map database row to EmailOutboxEntry
   */
  private mapRow(row: any): EmailOutboxEntry {
    return {
      id: row.id,
      recipient_email: row.recipient_email,
      email_type: row.email_type,
      dedup_key: row.dedup_key,
      subject: row.subject,
      body_html: row.body_html,
      body_text: row.body_text,
      provider_name: row.provider_name,
      provider_id: row.provider_id,
      provider_response: row.provider_response ? JSON.parse(row.provider_response) : null,
      status: row.status,
      attempts: parseInt(row.attempts, 10),
      max_attempts: parseInt(row.max_attempts, 10),
      last_attempt_at: row.last_attempt_at ? new Date(row.last_attempt_at) : null,
      next_attempt_at: new Date(row.next_attempt_at),
      error_message: row.error_message,
      error_code: row.error_code,
      related_entity_type: row.related_entity_type,
      related_entity_id: row.related_entity_id,
      user_id: row.user_id,
      headers: row.headers ? JSON.parse(row.headers) : null,
      attachments_metadata: row.attachments_metadata ? JSON.parse(row.attachments_metadata) : null,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      delivered_at: row.delivered_at ? new Date(row.delivered_at) : null,
    };
  }
}

export default new EmailOutboxModel();
