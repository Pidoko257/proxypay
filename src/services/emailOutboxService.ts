import { EmailOutboxModel, EmailOutboxEntry, EmailOutboxStatus } from "../models/emailOutbox";
import logger from "../utils/logger";
import crypto from "crypto";

export interface QueueEmailOptions {
  recipient_email: string;
  email_type:
    | "transaction_receipt"
    | "transaction_failure"
    | "kyc_status"
    | "account_lockout"
    | "account_security"
    | "invoice"
    | "subscription_event"
    | "payment_link_expiration"
    | string;
  subject: string;
  body_html?: string;
  body_text?: string;
  dedup_key?: string | null;
  max_attempts?: number;
  related_entity_type?: string | null;
  related_entity_id?: string | null;
  user_id?: string | null;
  headers?: Record<string, any>;
  attachments_metadata?: Array<{ name: string; contentType: string; size: number }>;
}

export interface OutboxStatistics {
  pending: number;
  failed: number;
  delivered: number;
  dlq: number;
  processing: number;
  total: number;
}

/**
 * EmailOutboxService: Business logic for email outbox operations
 *
 * Responsibilities:
 * - Queue emails with automatic deduplication
 * - Track delivery attempts and provider responses
 * - Schedule retries with exponential backoff
 * - Move to DLQ after max attempts
 * - Provide monitoring and admin visibility
 */
export class EmailOutboxService {
  private outboxModel: EmailOutboxModel;
  private log = logger;

  constructor() {
    this.outboxModel = new EmailOutboxModel();
  }

  /**
   * Queue an email for delivery
   *
   * If dedup_key is provided and a recent email with the same key exists
   * in pending/processing/delivered state, returns null (already queued).
   *
   * @returns EmailOutboxEntry or null if deduplicat catch triggered
   */
  async queueEmail(options: QueueEmailOptions): Promise<EmailOutboxEntry | null> {
    const {
      recipient_email,
      email_type,
      subject,
      body_html,
      body_text,
      dedup_key: providedDedupKey,
      max_attempts = 5,
      related_entity_type,
      related_entity_id,
      user_id,
      headers,
      attachments_metadata,
    } = options;

    // Validate email
    if (!recipient_email || !recipient_email.includes("@")) {
      this.log.warn({ recipient_email, email_type }, "Invalid recipient email");
      return null;
    }

    // Generate or use provided dedup key
    const dedup_key = providedDedupKey ?? this.generateDedupKey(email_type, recipient_email, related_entity_type, related_entity_id);

    try {
      const entry = await this.outboxModel.create({
        recipient_email,
        email_type,
        subject,
        body_html,
        body_text,
        dedup_key,
        max_attempts,
        related_entity_type,
        related_entity_id,
        user_id,
        headers,
        attachments_metadata,
      });

      if (entry) {
        this.log.info(
          {
            id: entry.id,
            email_type,
            recipient: this.maskEmail(recipient_email),
            dedup_key,
          },
          "Email queued for outbox",
        );
      } else {
        this.log.info(
          {
            email_type,
            recipient: this.maskEmail(recipient_email),
            dedup_key,
          },
          "Email already queued (dedup caught)",
        );
      }

      return entry;
    } catch (error) {
      this.log.error(
        {
          error,
          email_type,
          recipient: this.maskEmail(recipient_email),
        },
        "Failed to queue email",
      );
      throw error;
    }
  }

  /**
   * Get next batch of emails to process
   */
  async getPendingEmails(limit: number = 100): Promise<EmailOutboxEntry[]> {
    try {
      return await this.outboxModel.queryPending({ limit });
    } catch (error) {
      this.log.error({ error, limit }, "Failed to query pending emails");
      throw error;
    }
  }

  /**
   * Mark email as processing
   */
  async markProcessing(id: string): Promise<EmailOutboxEntry | null> {
    try {
      return await this.outboxModel.updateStatus(id, { status: "processing" });
    } catch (error) {
      this.log.error({ error, id }, "Failed to mark email as processing");
      throw error;
    }
  }

  /**
   * Mark email as delivered with provider response
   */
  async markDelivered(id: string, providerInfo?: { name: string; messageId: string; response?: Record<string, any> }): Promise<EmailOutboxEntry | null> {
    try {
      return await this.outboxModel.updateStatus(id, {
        status: "delivered",
        provider_name: providerInfo?.name,
        provider_id: providerInfo?.messageId,
        provider_response: providerInfo?.response,
        delivered_at: new Date(),
      });
    } catch (error) {
      this.log.error({ error, id, providerInfo }, "Failed to mark email as delivered");
      throw error;
    }
  }

  /**
   * Record failed attempt and schedule retry
   */
  async recordFailedAttempt(
    id: string,
    error: {
      message: string;
      code?: string;
    },
  ): Promise<EmailOutboxEntry | null> {
    try {
      const entry = await this.outboxModel.recordAttempt(id, error);

      if (entry) {
        if (entry.status === "dlq") {
          this.log.warn(
            { id, attempts: entry.attempts, maxAttempts: entry.max_attempts },
            "Email moved to DLQ after max attempts",
          );
        } else {
          this.log.info(
            { id, attempts: entry.attempts, nextRetry: entry.next_attempt_at },
            "Email retry scheduled",
          );
        }
      }

      return entry;
    } catch (error) {
      this.log.error({ error, id }, "Failed to record failed attempt");
      throw error;
    }
  }

  /**
   * Move email to DLQ after exhausting retries
   */
  async moveToDLQ(id: string, reason: string): Promise<EmailOutboxEntry | null> {
    try {
      const entry = await this.outboxModel.moveToDLQ(id, reason);
      if (entry) {
        this.log.warn(
          {
            id,
            reason,
            recipient: this.maskEmail(entry.recipient_email),
            attempts: entry.attempts,
          },
          "Email moved to DLQ",
        );
      }
      return entry;
    } catch (error) {
      this.log.error({ error, id, reason }, "Failed to move email to DLQ");
      throw error;
    }
  }

  /**
   * Find email by ID
   */
  async findById(id: string): Promise<EmailOutboxEntry | null> {
    try {
      return await this.outboxModel.findById(id);
    } catch (error) {
      this.log.error({ error, id }, "Failed to find email");
      throw error;
    }
  }

  /**
   * Find email by dedup key
   */
  async findByDedupKey(dedup_key: string): Promise<EmailOutboxEntry | null> {
    try {
      return await this.outboxModel.findByDedupKey(dedup_key);
    } catch (error) {
      this.log.error({ error, dedup_key }, "Failed to find email by dedup key");
      throw error;
    }
  }

  /**
   * Get outbox statistics
   */
  async getStatistics(): Promise<OutboxStatistics> {
    try {
      const stats = await this.outboxModel.getStats();
      return {
        ...stats,
        total: stats.pending + stats.failed + stats.delivered + stats.dlq + stats.processing,
      };
    } catch (error) {
      this.log.error({ error }, "Failed to get outbox statistics");
      throw error;
    }
  }

  /**
   * List emails with filters (for admin dashboard)
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
    try {
      return await this.outboxModel.listWithFilters(filters);
    } catch (error) {
      this.log.error({ error, filters }, "Failed to list emails with filters");
      throw error;
    }
  }

  /**
   * Generate dedup key from context
   */
  private generateDedupKey(
    email_type: string,
    recipient_email: string,
    related_entity_type?: string | null,
    related_entity_id?: string | null,
  ): string {
    return EmailOutboxModel.generateDedupKey(
      email_type,
      recipient_email,
      related_entity_type,
      related_entity_id,
    );
  }

  /**
   * Mask email for logging
   */
  private maskEmail(email: string): string {
    const [local, domain] = email.split("@");
    if (!local || local.length <= 2) return `***@${domain}`;
    return `${local[0]}${"*".repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
  }
}

export const emailOutboxService = new EmailOutboxService();
