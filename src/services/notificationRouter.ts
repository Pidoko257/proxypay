import { EmailService, emailService } from "./email";
import { SmsService, smsService } from "./sms";
import { PushNotificationService, pushNotificationService } from "./push";
import { WhatsappService, whatsappService } from "./whatsapp";
import { PagerDutyService, pagerDutyService } from "./pagerDutyService";
import {
  hashDedupParts,
  notificationDeduplicator,
} from "./notificationDeduplicator";
import { UserModel } from "../models/users";
import { Transaction } from "../models/transaction";
import { recordDeliveryAsync } from "./notificationHealthService";

export type NotificationSeverity = "low" | "medium" | "high" | "critical";

export type NotificationChannel = "email" | "sms" | "push" | "whatsapp" | "pagerduty";

export interface NotificationContext {
  userId?: string;
  transactionId?: string;
  transaction?: Transaction;
  severity: NotificationSeverity;
  category: string;
  title: string;
  message: string;
  data?: Record<string, any>;
  locale?: string;
  /**
   * Stable identity of the notification event used for deduplication.
   * When omitted, one is derived from the context (category, entity id,
   * or a hash of the content). Only the first send within the dedup window
   * is delivered.
   */
  dedupKey?: string;
}

export interface DisputeNotificationContext {
  disputeId: string;
  transactionId: string;
  event: string;
  status: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationRoutingRule {
  severity: NotificationSeverity;
  channels: NotificationChannel[];
  required: boolean; // If true, notification must be sent even if user preferences disable it
}

export interface UserNotificationPreferences {
  email: boolean;
  sms: boolean;
  push: boolean;
  whatsapp: boolean;
  severityThreshold: NotificationSeverity; // Minimum severity to notify
}

/**
 * Context for routing a provider reconciliation alert through the operational
 * channel. Carries the provider/date/reference identity so the alert payload
 * is actionable and deduplication is stable across job runs.
 */
export interface ReconciliationAlertContext {
  provider: string;
  date: string;
  reference: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  data?: Record<string, any>;
}

export interface ReconciliationAlertResult {
  /** True when the alert was delivered (or already acknowledged). */
  delivered: boolean;
  /** True when the alert was suppressed because it was already sent. */
  deduplicated: boolean;
  /** Acknowledgement state recorded for the alert. */
  acknowledged: boolean;
  dedupKey: string;
}

/**
 * Advanced Notification Router
 *
 * Routes notifications by severity to appropriate channels based on:
 * - Notification severity level
 * - User preferences
 * - Channel availability
 * - Business rules
 */
export class NotificationRouter {
  private emailService: EmailService;
  private smsService: SmsService;
  private pushService: PushNotificationService;
  private whatsappService: WhatsappService;
  private pagerDutyService: PagerDutyService;
  private userModel: UserModel;

  // Default routing rules by severity
  private readonly routingRules: Record<NotificationSeverity, NotificationRoutingRule> = {
    low: {
      severity: "low",
      channels: ["push"],
      required: false,
    },
    medium: {
      severity: "medium",
      channels: ["email", "push", "sms"],
      required: false,
    },
    high: {
      severity: "high",
      channels: ["email", "push", "sms", "whatsapp"],
      required: false,
    },
    critical: {
      severity: "critical",
      channels: ["email", "push", "sms", "whatsapp", "pagerduty"],
      required: true,
    },
  };

  // Default user preferences
  private readonly defaultPreferences: UserNotificationPreferences = {
    email: true,
    sms: true,
    push: true,
    whatsapp: false, // WhatsApp requires opt-in
    severityThreshold: "medium",
  };

  // Acknowledgement state for reconciliation alerts, keyed by dedup key.
  private readonly reconciliationAcknowledgements = new Map<string, boolean>();

  constructor(userModel: UserModel) {
    this.emailService = emailService;
    this.smsService = smsService;
    this.pushService = pushNotificationService;
    this.whatsappService = whatsappService;
    this.pagerDutyService = pagerDutyService;
    this.userModel = userModel;
  }

  /**
   * Route a provider reconciliation alert through the operational channel.
   *
   * Alerts are deduplicated by provider/date/reference so repeated job runs do
   * not page on-call multiple times for the same discrepancy. The
   * acknowledgement state is recorded for every alert that is delivered.
   */
  async sendReconciliationAlert(
    alert: ReconciliationAlertContext,
  ): Promise<ReconciliationAlertResult> {
    const dedupKey = hashDedupParts([
      "reconciliation",
      alert.provider,
      alert.date,
      alert.reference,
      alert.severity,
    ]);

    if (this.reconciliationAcknowledgements.has(dedupKey)) {
      return {
        delivered: false,
        deduplicated: true,
        acknowledged: this.reconciliationAcknowledgements.get(dedupKey) ?? false,
        dedupKey,
      };
    }

    const context: NotificationContext = {
      severity: alert.severity,
      category: "provider_reconciliation",
      title: alert.title,
      message: alert.message,
      dedupKey,
      data: {
        ...alert.data,
        provider: alert.provider,
        date: alert.date,
        reference: alert.reference,
      },
    };

    const rule = this.routingRules[alert.severity];
    const channels = await this.getEnabledChannels(context, rule);

    for (const channel of channels) {
      await this.sendToChannel(channel, context);
    }

    this.reconciliationAcknowledgements.set(dedupKey, true);

    return {
      delivered: channels.length > 0,
      deduplicated: false,
      acknowledged: true,
      dedupKey,
    };
  }

  /**
   * Get user notification preferences
   */
  private async getUserPreferences(userId: string): Promise<UserNotificationPreferences> {
    try {
      const user = await this.userModel.findById(userId);
      if (!user) {
        return this.defaultPreferences;
      }

      // In a real implementation, preferences would be stored in user profile
      // For now, return defaults with user's language preference
      return {
        ...this.defaultPreferences,
        // Could be extended to read from user.notificationPreferences field
      };
    } catch (error) {
      console.error(`Failed to get user preferences for ${userId}:`, error);
      return this.defaultPreferences;
    }
  }

  /**
   * Check if severity meets user's threshold
   */
  private meetsSeverityThreshold(
    severity: NotificationSeverity,
    threshold: NotificationSeverity,
  ): boolean {
    const severityLevels: Record<NotificationSeverity, number> = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };

    return severityLevels[severity] >= severityLevels[threshold];
  }

  /**
   * Filter channels based on user preferences and severity
   */
  private async getEnabledChannels(
    context: NotificationContext,
    rule: NotificationRoutingRule,
  ): Promise<NotificationChannel[]> {
    if (rule.required) {
      // Critical notifications always go through all channels
      return rule.channels;
    }

    if (!context.userId) {
      // System notifications without user context use all channels
      return rule.channels;
    }

    const preferences = await this.getUserPreferences(context.userId);

    // Check if notification meets user's severity threshold
    if (!this.meetsSeverityThreshold(context.severity, preferences.severityThreshold)) {
      return [];
    }

    // Filter channels based on user preferences
    return rule.channels.filter((channel) => {
      switch (channel) {
        case "email":
          return preferences.email;
        case "sms":
          return preferences.sms;
        case "push":
          return preferences.push;
        case "whatsapp":
          return preferences.whatsapp;
        case "pagerduty":
          return true; // System alerts always go to PagerDuty if configured
        default:
          return false;
      }
    });
  }

  /**
   * Send notification through specified channel
   */
  private async sendToChannel(
    channel: NotificationChannel,
    context: NotificationContext,
  ): Promise<void> {
    // #479 – every channel attempt is recorded so notification health can be
    // observed. Without this, a misconfigured provider is indistinguishable
    // from a healthy one because errors are deliberately swallowed below.
    const startedAt = Date.now();
    const notificationKey =
      context.dedupKey ??
      `${context.category}:${context.transactionId ?? context.userId ?? "system"}`;

    try {
      switch (channel) {
        case "email":
          await this.sendEmailNotification(context);
          break;
        case "sms":
          await this.sendSmsNotification(context);
          break;
        case "push":
          await this.sendPushNotification(context);
          break;
        case "whatsapp":
          await this.sendWhatsappNotification(context);
          break;
        case "pagerduty":
          await this.sendPagerDutyNotification(context);
          break;
      }

      recordDeliveryAsync({
        notificationKey,
        channel,
        status: "delivered",
        durationMs: Date.now() - startedAt,
        category: context.category,
        severity: context.severity,
        userId: context.userId ?? null,
        transactionId: context.transactionId ?? null,
      });
    } catch (error) {
      console.error(`Failed to send ${channel} notification:`, error);

      recordDeliveryAsync({
        notificationKey,
        channel,
        status: "failed",
        durationMs: Date.now() - startedAt,
        category: context.category,
        severity: context.severity,
        userId: context.userId ?? null,
        transactionId: context.transactionId ?? null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      // Don't throw - we don't want one channel failure to stop others
    }
  }

  private async sendEmailNotification(context: NotificationContext): Promise<void> {
    if (!context.userId) return;

    const user = await this.userModel.findById(context.userId);
    if (!user?.email) return;

    await this.emailService.sendEmail({
      to: user.email,
      subject: context.title,
      text: context.message,
    });
  }

  private async sendSmsNotification(context: NotificationContext): Promise<void> {
    if (!context.userId) return;

    const user = await this.userModel.findById(context.userId);
    if (!user?.phoneNumber) return;

    await this.smsService.sendSms({
      to: user.phoneNumber,
      message: `${context.title}: ${context.message}`,
    });
  }

  private async sendPushNotification(context: NotificationContext): Promise<void> {
    if (!context.userId) return;

    await this.pushService.sendPush({
      userId: context.userId,
      title: context.title,
      body: context.message,
      data: context.data,
    });
  }

  private async sendWhatsappNotification(context: NotificationContext): Promise<void> {
    if (!context.userId) return;

    const user = await this.userModel.findById(context.userId);
    if (!user?.phoneNumber) return;

    await this.whatsappService.sendMessage({
      to: user.phoneNumber,
      message: `${context.title}: ${context.message}`,
    });
  }

  private async sendPagerDutyNotification(context: NotificationContext): Promise<void> {
    await this.pagerDutyService.triggerIncident({
      summary: context.title,
      severity: context.severity,
      source: context.category,
      details: {
        message: context.message,
        ...context.data,
      },
      dedupKey: context.dedupKey,
    });
  }
}
