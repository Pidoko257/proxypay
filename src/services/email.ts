import sgMail from "@sendgrid/mail";
import { Transaction } from "../models/transaction";
import { DailySnapshot } from "../models/snapshot";
import { GrowthMetrics } from "./snapshotService";
import { resolveLocale, translate } from "../utils/i18n";
import { receiptTemplateService } from "./receiptTemplateService";
import { emailOutboxService } from "./emailOutboxService";
import logger from "../utils/logger";

export interface LockoutEmailOptions {
  minutesRemaining: number;
  unlocksAt: Date;
  ipAddress?: string;
  locale?: string;
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY || "");

export interface EmailOptions {
  to: string;
  templateId: string;
  dynamicTemplateData: Record<string, any>;
  html?: string;
  text?: string;
  subject?: string;
  attachments?: Array<{
    content: string;
    filename: string;
    type: string;
    disposition: string;
  }>;
}

export interface VulnerabilityReport {
  total: number;
  critical: number;
  high: number;
  moderate: number;
  low: number;
  info: number;
}

/**
 * EmailService: Routes all email through the outbox system for reliable delivery
 *
 * All emails are queued in the email_outbox table with automatic deduplication,
 * bounded retries, and provider response tracking. The separate emailOutboxWorker
 * handles actual delivery to SendGrid.
 *
 * Benefits:
 * - Transactional: emails are queued atomically with business operations
 * - Resilient: retries on transient failures, moves to DLQ on permanent failures
 * - Observable: full audit trail and admin visibility
 * - Deduplicat: automatic dedup prevents duplicate emails for same transaction
 */
export class EmailService {
  private resolveTemplateId(
    baseEnvName: "SENDGRID_RECEIPT_TEMPLATE_ID" | "SENDGRID_FAILURE_TEMPLATE_ID",
    locale: string,
  ): string {
    const resolvedLocale = resolveLocale(locale).toUpperCase();
    const localizedEnvKey = `${baseEnvName}_${resolvedLocale}`;

    return process.env[localizedEnvKey] || process.env[baseEnvName] || "";
  }

  /**
   * Queue email for delivery via outbox
   * Returns immediately; actual delivery happens asynchronously via worker
   */
  async sendEmail(options: EmailOptions): Promise<void> {
    if (process.env.NODE_ENV === "test") {
      logger.debug("Skipping email send in test environment");
      return;
    }

    try {
      // Build subject from template or provided
      let subject = options.subject || "Notification from ProxyPay";

      // Queue email with generic type
      await emailOutboxService.queueEmail({
        recipient_email: options.to,
        email_type: "generic_notification",
        subject,
        body_html: options.html,
        body_text: options.text,
        headers: {
          templateId: options.templateId,
          dynamicTemplateData: options.dynamicTemplateData,
        },
      });
    } catch (error) {
      logger.error(
        { error, to: options.to },
        "Failed to queue email",
      );
      // Don't throw to avoid blocking caller
    }
  }

  async sendTransactionReceipt(
    email: string,
    transaction: Transaction,
    locale = "en",
    merchantDisplayName?: string | null,
    merchantId?: string | null,
    branding?: { businessName?: string | null; logoUrl?: string | null; primaryColor?: string | null },
  ): Promise<void> {
    const resolvedLocale = resolveLocale(locale);

    const render = await receiptTemplateService.renderReceipt({
      transaction,
      merchantId: merchantId ?? null,
      merchantDisplayName: merchantDisplayName ?? null,
      businessName: branding?.businessName ?? null,
      logoUrl: branding?.logoUrl ?? null,
      primaryColor: branding?.primaryColor ?? null,
      locale: resolvedLocale,
    });

    const subject = `Transaction Receipt - ${transaction.referenceNumber}`;

    try {
      // Queue via outbox with transaction dedup
      await emailOutboxService.queueEmail({
        recipient_email: email,
        email_type: "transaction_receipt",
        subject,
        body_html: render.html,
        body_text: render.plain,
        // Dedup key ensures only one receipt per transaction
        dedup_key: `receipt-${transaction.id}`,
        related_entity_type: "transaction",
        related_entity_id: transaction.id,
      });
    } catch (error) {
      logger.error(
        { error, transactionId: transaction.id, recipient: email },
        "Failed to queue transaction receipt",
      );
    }
  }

  async sendAccountLockoutNotification(
    email: string,
    options: LockoutEmailOptions,
  ): Promise<void> {
    if (process.env.NODE_ENV === "test") {
      logger.debug("Skipping lockout email in test environment");
      return;
    }

    const { minutesRemaining, unlocksAt, ipAddress, locale = "en" } = options;
    const resolvedLocale = resolveLocale(locale);

    const unlockTime = unlocksAt.toLocaleString(resolvedLocale);
    const ipNote = ipAddress
      ? `Request originated from IP: ${ipAddress}`
      : "";

    const subject = "Your account has been temporarily locked";
    const body_html = `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#c0392b">Account Temporarily Locked</h2>
        <p>We detected multiple failed login attempts on your ProxyPay account.</p>
        <p>For your security, your account has been <strong>temporarily locked for ${minutesRemaining} minute${minutesRemaining === 1 ? "" : "s"}</strong>.</p>
        <p>You will be able to log in again after:<br>
          <strong>${unlockTime}</strong>
        </p>
        ${ipNote ? `<p style="color:#666;font-size:13px;">${ipNote}</p>` : ""}
        <p>If this wasn't you, please contact our support team immediately.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#999;font-size:12px">
          &copy; ${new Date().getFullYear()} ProxyPay. This is an automated security notification.
        </p>
      </div>
    `;

    const body_text = `Your ProxyPay account has been temporarily locked due to multiple failed login attempts.\n\n` +
      `You can try again in ${minutesRemaining} minute${minutesRemaining === 1 ? "" : "s"} (after ${unlockTime}).\n\n` +
      `If this wasn't you, please contact support immediately.`;

    try {
      await emailOutboxService.queueEmail({
        recipient_email: email,
        email_type: "account_lockout",
        subject,
        body_html,
        body_text,
      });
    } catch (error) {
      logger.error(
        { error, recipient: email },
        "Failed to queue account lockout notification",
      );
    }
  }

  async sendTransactionFailure(
    email: string,
    transaction: Transaction,
    reason: string,
    locale = "en",
    merchantDisplayName?: string | null,
  ): Promise<void> {
    const subject = `Transaction Failed - ${transaction.referenceNumber}`;
    const body_text = `Your transaction (${transaction.referenceNumber}) failed: ${reason}`;

    try {
      await emailOutboxService.queueEmail({
        recipient_email: email,
        email_type: "transaction_failure",
        subject,
        body_text,
        // Use same dedup key as receipt to avoid duplicates
        dedup_key: `failure-${transaction.id}`,
        related_entity_type: "transaction",
        related_entity_id: transaction.id,
      });
    } catch (error) {
      logger.error(
        { error, transactionId: transaction.id, recipient: email },
        "Failed to queue transaction failure notification",
      );
    }
  }

  async sendSubscriptionPaused(email: string, subscriptionId: string, attempts: number, locale = "en") {
    if (process.env.NODE_ENV === "test") {
      logger.debug("Skipping subscription paused email in test environment");
      return;
    }

    try {
      await emailOutboxService.queueEmail({
        recipient_email: email,
        email_type: "subscription_event",
        subject: "Subscription Paused",
        body_text: `Your subscription (${subscriptionId}) has been paused after ${attempts} failed attempts. Please review and resume if required.`,
        dedup_key: `subscription-paused-${subscriptionId}`,
        related_entity_type: "subscription",
        related_entity_id: subscriptionId,
      });
    } catch (error) {
      logger.error(
        { error, subscriptionId, recipient: email },
        "Failed to queue subscription paused notification",
      );
    }
  }

  async sendSubscriptionResumed(email: string, subscriptionId: string, locale = "en") {
    if (process.env.NODE_ENV === "test") {
      logger.debug("Skipping subscription resumed email in test environment");
      return;
    }

    try {
      await emailOutboxService.queueEmail({
        recipient_email: email,
        email_type: "subscription_event",
        subject: "Subscription Resumed",
        body_text: `Your subscription (${subscriptionId}) has been resumed.`,
        dedup_key: `subscription-resumed-${subscriptionId}`,
        related_entity_type: "subscription",
        related_entity_id: subscriptionId,
      });
    } catch (error) {
      logger.error(
        { error, subscriptionId, recipient: email },
        "Failed to queue subscription resumed notification",
      );
    }
  }

  async sendSubscriptionFailure(email: string, subscriptionId: string, reason: string, locale = "en") {
    if (process.env.NODE_ENV === "test") {
      logger.debug("Skipping subscription failure email in test environment");
      return;
    }

    try {
      await emailOutboxService.queueEmail({
        recipient_email: email,
        email_type: "subscription_event",
        subject: "Subscription Failed",
        body_text: `Your subscription (${subscriptionId}) failed: ${reason}`,
        dedup_key: `subscription-failure-${subscriptionId}`,
        related_entity_type: "subscription",
        related_entity_id: subscriptionId,
      });
    } catch (error) {
      logger.error(
        { error, subscriptionId, recipient: email },
        "Failed to queue subscription failure notification",
      );
    }
  }

  async sendManagementSummary(
    email: string,
    snapshot: DailySnapshot,
    growth: GrowthMetrics,
  ): Promise<void> {
    const subject = `Daily Financial Summary - ${snapshot.snapshotDate}`;
    const body_html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #eee;padding:20px;">
        <h2 style="color:#2c3e50;border-bottom:2px solid #3498db;padding-bottom:10px;">Daily Financial Summary</h2>
        <p><strong>Date:</strong> ${snapshot.snapshotDate}</p>
        
        <div style="background:#f9f9f9;padding:15px;border-radius:5px;margin:20px 0;">
          <h3 style="margin-top:0;color:#2980b9;">Balances</h3>
          <table style="width:100%;">
            <tr><td>Total Balance:</td><td style="text-align:right;"><strong>${snapshot.totalBalance}</strong></td></tr>
            <tr><td style="padding-left:15px;color:#666;">- Main Balance:</td><td style="text-align:right;color:#666;">${snapshot.totalMainBalance}</td></tr>
            <tr><td style="padding-left:15px;color:#666;">- Vault Balance:</td><td style="text-align:right;color:#666;">${snapshot.totalVaultBalance}</td></tr>
            <tr><td>Balance Growth (DoD):</td><td style="text-align:right;color:${growth.balanceGrowth >= 0 ? "#27ae60" : "#c0392b"};">${growth.balanceGrowth.toFixed(2)}%</td></tr>
          </table>
        </div>

        <div style="background:#f9f9f9;padding:15px;border-radius:5px;margin:20px 0;">
          <h3 style="margin-top:0;color:#2980b9;">Volume</h3>
          <table style="width:100%;">
            <tr><td>Daily Volume:</td><td style="text-align:right;"><strong>${snapshot.dailyVolume}</strong></td></tr>
            <tr><td>Transaction Count:</td><td style="text-align:right;">${snapshot.transactionCount}</td></tr>
            <tr><td>Volume Growth (DoD):</td><td style="text-align:right;color:${growth.volumeGrowth >= 0 ? "#27ae60" : "#c0392b"};">${growth.volumeGrowth.toFixed(2)}%</td></tr>
          </table>
        </div>

        <p style="color:#999;font-size:12px;margin-top:30px;text-align:center;">
          &copy; ${new Date().getFullYear()} ProxyPay. This is an automated management report.
        </p>
      </div>
    `;

    try {
      await emailOutboxService.queueEmail({
        recipient_email: email,
        email_type: "management_summary",
        subject,
        body_html,
      });
    } catch (error) {
      logger.error(
        { error, recipient: email },
        "Failed to queue management summary",
      );
    }
  }

  async sendVulnerabilityReport(
    email: string,
    report: VulnerabilityReport,
  ): Promise<void> {
    const subject = `Weekly Security Vulnerability Report - ${new Date().toLocaleDateString()}`;
    const body_html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #eee;padding:20px;">
        <h2 style="color:#2c3e50;border-bottom:2px solid #e74c3c;padding-bottom:10px;">Security Vulnerability Report</h2>
        <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
        
        <div style="background:#f9f9f9;padding:15px;border-radius:5px;margin:20px 0;">
          <h3 style="margin-top:0;color:#c0392b;">Summary</h3>
          <table style="width:100%; font-size: 16px;">
            <tr><td style="padding: 4px 0;">Total Vulnerabilities:</td><td style="text-align:right;"><strong>${report.total}</strong></td></tr>
            <tr><td style="color:#c0392b; padding: 4px 0;">Critical:</td><td style="text-align:right;color:#c0392b;"><strong>${report.critical}</strong></td></tr>
            <tr><td style="color:#e67e22; padding: 4px 0;">High:</td><td style="text-align:right;color:#e67e22;"><strong>${report.high}</strong></td></tr>
            <tr><td style="color:#f39c12; padding: 4px 0;">Moderate:</td><td style="text-align:right;color:#f39c12;"><strong>${report.moderate}</strong></td></tr>
            <tr><td style="color:#27ae60; padding: 4px 0;">Low:</td><td style="text-align:right;color:#27ae60;"><strong>${report.low}</strong></td></tr>
          </table>
        </div>
        <p style="color:#999;font-size:12px;margin-top:30px;text-align:center;">
          &copy; ${new Date().getFullYear()} ProxyPay. Automated Security Audit.
        </p>
      </div>
    `;

    try {
      await emailOutboxService.queueEmail({
        recipient_email: email,
        email_type: "security_report",
        subject,
        body_html,
      });
    } catch (error) {
      logger.error(
        { error, recipient: email },
        "Failed to queue vulnerability report",
      );
    }
  }
}

export const emailService = new EmailService();
