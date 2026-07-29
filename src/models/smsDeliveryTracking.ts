import { queryRead, queryWrite } from "../config/database";

export interface SmsDeliveryTracking {
  id: string;
  userId?: string;
  transactionId?: string;
  phoneNumber: string;
  messageContent: string;
  messageType: string;
  status: "pending" | "sent" | "delivered" | "failed" | "skipped";
  statusReason?: string;
  provider: string;
  providerMessageId?: string;
  costUsd?: number;
  currency: string;
  retryCount: number;
  lastRetryAt?: Date;
  maxRetries: number;
  createdAt: Date;
  sentAt?: Date;
  deliveredAt?: Date;
  failedAt?: Date;
}

export class SmsDeliveryTrackingModel {
  /**
   * Create a new SMS delivery tracking record
   */
  async createRecord(data: {
    userId?: string;
    transactionId?: string;
    phoneNumber: string;
    messageContent: string;
    messageType: string;
    provider: string;
    maxRetries?: number;
  }): Promise<SmsDeliveryTracking> {
    const result = await queryWrite(
      `INSERT INTO sms_delivery_tracking 
       (user_id, transaction_id, phone_number, message_content, message_type, 
        provider, max_retries)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.userId || null,
        data.transactionId || null,
        data.phoneNumber,
        data.messageContent,
        data.messageType,
        data.provider,
        data.maxRetries || 3,
      ],
    );
    return this.mapRow(result.rows[0]);
  }

  /**
   * Update SMS delivery status
   */
  async updateStatus(
    recordId: string,
    status: SmsDeliveryTracking["status"],
    {
      providerMessageId,
      statusReason,
      sentAt,
      deliveredAt,
      failedAt,
    }: {
      providerMessageId?: string;
      statusReason?: string;
      sentAt?: Date;
      deliveredAt?: Date;
      failedAt?: Date;
    } = {},
  ): Promise<SmsDeliveryTracking> {
    const fields: string[] = ["status = $2"];
    const values: any[] = [recordId, status];
    let paramIdx = 3;

    if (providerMessageId !== undefined) {
      fields.push(`provider_message_id = $${paramIdx++}`);
      values.push(providerMessageId || null);
    }
    if (statusReason !== undefined) {
      fields.push(`status_reason = $${paramIdx++}`);
      values.push(statusReason || null);
    }
    if (sentAt !== undefined) {
      fields.push(`sent_at = $${paramIdx++}`);
      values.push(sentAt || null);
    }
    if (deliveredAt !== undefined) {
      fields.push(`delivered_at = $${paramIdx++}`);
      values.push(deliveredAt || null);
    }
    if (failedAt !== undefined) {
      fields.push(`failed_at = $${paramIdx++}`);
      values.push(failedAt || null);
    }

    const query = `UPDATE sms_delivery_tracking 
                   SET ${fields.join(", ")} 
                   WHERE id = $1 
                   RETURNING *`;

    const result = await queryWrite(query, values);
    return this.mapRow(result.rows[0]);
  }

  /**
   * Record a cost for an SMS
   */
  async recordCost(
    recordId: string,
    costUsd: number,
    currency: string = "USD",
  ): Promise<SmsDeliveryTracking> {
    const result = await queryWrite(
      `UPDATE sms_delivery_tracking 
       SET cost_usd = $2, currency = $3
       WHERE id = $1
       RETURNING *`,
      [recordId, costUsd, currency],
    );
    return this.mapRow(result.rows[0]);
  }

  /**
   * Increment retry count
   */
  async incrementRetry(recordId: string): Promise<SmsDeliveryTracking> {
    const result = await queryWrite(
      `UPDATE sms_delivery_tracking 
       SET retry_count = retry_count + 1, last_retry_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [recordId],
    );
    return this.mapRow(result.rows[0]);
  }

  /**
   * Find SMS delivery record by ID
   */
  async findById(recordId: string): Promise<SmsDeliveryTracking | null> {
    const result = await queryRead(
      "SELECT * FROM sms_delivery_tracking WHERE id = $1",
      [recordId],
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  /**
   * Find SMS records by transaction ID
   */
  async findByTransactionId(transactionId: string): Promise<SmsDeliveryTracking[]> {
    const result = await queryRead(
      "SELECT * FROM sms_delivery_tracking WHERE transaction_id = $1 ORDER BY created_at DESC",
      [transactionId],
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Find SMS records by user ID (with pagination)
   */
  async findByUserId(
    userId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<SmsDeliveryTracking[]> {
    const result = await queryRead(
      `SELECT * FROM sms_delivery_tracking 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Get SMS delivery statistics for a user
   */
  async getUserStats(userId: string): Promise<{
    totalSent: number;
    totalDelivered: number;
    totalFailed: number;
    totalSkipped: number;
    successRate: number;
  }> {
    const result = await queryRead(
      `SELECT 
         COUNT(*) FILTER (WHERE status = 'sent') as sent,
         COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
         COUNT(*) FILTER (WHERE status = 'failed') as failed,
         COUNT(*) FILTER (WHERE status = 'skipped') as skipped,
         COUNT(*) as total
       FROM sms_delivery_tracking 
       WHERE user_id = $1`,
      [userId],
    );

    const row = result.rows[0];
    const total = parseInt(row.total || "0", 10);
    const delivered = parseInt(row.delivered || "0", 10);

    return {
      totalSent: parseInt(row.sent || "0", 10),
      totalDelivered: delivered,
      totalFailed: parseInt(row.failed || "0", 10),
      totalSkipped: parseInt(row.skipped || "0", 10),
      successRate: total > 0 ? (delivered / total) * 100 : 0,
    };
  }

  /**
   * Get SMS cost summary for a user within a date range
   */
  async getCostSummary(
    userId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<{
    totalCost: number;
    successfulSmsCost: number;
    failedSmsCost: number;
    skippedSmsCost: number;
  }> {
    const result = await queryRead(
      `SELECT 
         SUM(COALESCE(cost_usd, 0)) FILTER (WHERE status IN ('sent', 'delivered')) as successful_cost,
         SUM(COALESCE(cost_usd, 0)) FILTER (WHERE status = 'failed') as failed_cost,
         SUM(COALESCE(cost_usd, 0)) FILTER (WHERE status = 'skipped') as skipped_cost,
         SUM(COALESCE(cost_usd, 0)) as total_cost
       FROM sms_delivery_tracking 
       WHERE user_id = $1 
         AND created_at >= $2 
         AND created_at < $3`,
      [userId, startDate, endDate],
    );

    const row = result.rows[0];
    return {
      totalCost: parseFloat(row.total_cost || "0"),
      successfulSmsCost: parseFloat(row.successful_cost || "0"),
      failedSmsCost: parseFloat(row.failed_cost || "0"),
      skippedSmsCost: parseFloat(row.skipped_cost || "0"),
    };
  }

  /**
   * Find pending SMS records (for retries)
   */
  async findPendingForRetry(limit: number = 100): Promise<SmsDeliveryTracking[]> {
    const result = await queryRead(
      `SELECT * FROM sms_delivery_tracking 
       WHERE status = 'pending' 
         AND retry_count < max_retries
         AND created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
       ORDER BY created_at ASC 
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Get SMS statistics by provider
   */
  async getStatsByProvider(
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      provider: string;
      totalSent: number;
      totalDelivered: number;
      totalFailed: number;
      totalCost: number;
    }>
  > {
    const result = await queryRead(
      `SELECT 
         provider,
         COUNT(*) FILTER (WHERE status = 'sent') as sent,
         COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
         COUNT(*) FILTER (WHERE status = 'failed') as failed,
         SUM(COALESCE(cost_usd, 0)) as total_cost
       FROM sms_delivery_tracking 
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY provider`,
      [startDate, endDate],
    );

    return result.rows.map((row) => ({
      provider: row.provider,
      totalSent: parseInt(row.sent || "0", 10),
      totalDelivered: parseInt(row.delivered || "0", 10),
      totalFailed: parseInt(row.failed || "0", 10),
      totalCost: parseFloat(row.total_cost || "0"),
    }));
  }

  private mapRow(row: any): SmsDeliveryTracking {
    return {
      id: row.id,
      userId: row.user_id,
      transactionId: row.transaction_id,
      phoneNumber: row.phone_number,
      messageContent: row.message_content,
      messageType: row.message_type,
      status: row.status,
      statusReason: row.status_reason,
      provider: row.provider,
      providerMessageId: row.provider_message_id,
      costUsd: row.cost_usd ? parseFloat(row.cost_usd) : undefined,
      currency: row.currency || "USD",
      retryCount: row.retry_count || 0,
      lastRetryAt: row.last_retry_at ? new Date(row.last_retry_at) : undefined,
      maxRetries: row.max_retries || 3,
      createdAt: new Date(row.created_at),
      sentAt: row.sent_at ? new Date(row.sent_at) : undefined,
      deliveredAt: row.delivered_at ? new Date(row.delivered_at) : undefined,
      failedAt: row.failed_at ? new Date(row.failed_at) : undefined,
    };
  }
}

export const smsDeliveryTrackingModel = new SmsDeliveryTrackingModel();
