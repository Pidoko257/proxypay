import { pool } from "../config/database";
import logger from "../utils/logger";
import { KYCWebhookEvent, dispatchKYCStatusEvent } from "./kycWebhookService";

export type DeliverabilityStatus =
  | "delivered"
  | "opted_out"
  | "status_filtered"
  | "channels_disabled"
  | "failed";

export interface MerchantKycNotificationPreferences {
  merchantId: string;
  userId?: string;
  optedOut?: boolean;
  emailNotifications: boolean;
  webhookNotifications: boolean;
  smsNotifications?: boolean;
  notifyOnApproved: boolean;
  notifyOnRejected: boolean;
  notifyOnPending: boolean;
  notifyOnReview?: boolean;
  updatedAt: Date;
}

export type KycNotificationPreferences = MerchantKycNotificationPreferences;

export interface KycStatusNotificationRecord {
  id: string;
  merchantId: string;
  userId?: string;
  applicantId: string;
  previousStatus: string;
  newStatus: string;
  channels: string[];
  delivered: boolean;
  deliverabilityStatus: DeliverabilityStatus;
  suppressionReason?: string;
  rejectionReasons?: string[];
  notifiedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface DeliverabilityMetrics {
  total: number;
  delivered: number;
  suppressed: number;
  byStatus: Record<DeliverabilityStatus, number>;
}

export class KycNotificationService {
  private preferences: Map<string, MerchantKycNotificationPreferences> = new Map();
  private notificationHistory: KycStatusNotificationRecord[] = [];

  /**
   * Set merchant or user KYC notification preferences
   */
  async setPreferences(
    identifier: string,
    prefs: Partial<MerchantKycNotificationPreferences>
  ): Promise<MerchantKycNotificationPreferences> {
    const existing = this.preferences.get(identifier) || {
      merchantId: identifier,
      userId: prefs.userId || identifier,
      optedOut: false,
      emailNotifications: true,
      webhookNotifications: true,
      smsNotifications: false,
      notifyOnApproved: true,
      notifyOnRejected: true,
      notifyOnPending: false,
      notifyOnReview: true,
      updatedAt: new Date(),
    };

    const updated: MerchantKycNotificationPreferences = {
      ...existing,
      ...prefs,
      merchantId: identifier,
      userId: prefs.userId || existing.userId || identifier,
      updatedAt: new Date(),
    };

    this.preferences.set(identifier, updated);
    return updated;
  }

  /**
   * Get merchant or user KYC notification preferences
   */
  async getPreferences(identifier: string): Promise<MerchantKycNotificationPreferences> {
    return (
      this.preferences.get(identifier) || {
        merchantId: identifier,
        userId: identifier,
        optedOut: false,
        emailNotifications: true,
        webhookNotifications: true,
        smsNotifications: false,
        notifyOnApproved: true,
        notifyOnRejected: true,
        notifyOnPending: false,
        notifyOnReview: true,
        updatedAt: new Date(),
      }
    );
  }

  /**
   * Opt out a user or merchant from all KYC notifications
   */
  async optOut(identifier: string): Promise<MerchantKycNotificationPreferences> {
    return this.setPreferences(identifier, { optedOut: true });
  }

  /**
   * Opt in a user or merchant to KYC notifications
   */
  async optIn(identifier: string): Promise<MerchantKycNotificationPreferences> {
    return this.setPreferences(identifier, { optedOut: false });
  }

  /**
   * Notify merchant/user of KYC status change respecting notification preferences
   */
  async notifyKycStatusChange(params: {
    merchantId: string;
    userId?: string;
    applicantId: string;
    previousStatus: string;
    newStatus: "approved" | "rejected" | "pending" | "review";
    rejectionReasons?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<KycStatusNotificationRecord> {
    const { merchantId, userId, applicantId, previousStatus, newStatus, rejectionReasons, metadata } = params;
    const lookupKey = userId || merchantId;
    const prefs = await this.getPreferences(lookupKey);

    const channels: string[] = [];
    let deliverabilityStatus: DeliverabilityStatus = "delivered";
    let suppressionReason: string | undefined;

    // 1. Check global opt-out
    if (prefs.optedOut) {
      deliverabilityStatus = "opted_out";
      suppressionReason = "User has opted out of KYC notifications";
    } else {
      // 2. Check status-specific preference
      const isStatusAllowed =
        (newStatus === "approved" && prefs.notifyOnApproved) ||
        (newStatus === "rejected" && prefs.notifyOnRejected) ||
        (newStatus === "pending" && prefs.notifyOnPending) ||
        (newStatus === "review" && (prefs.notifyOnReview ?? true));

      if (!isStatusAllowed) {
        deliverabilityStatus = "status_filtered";
        suppressionReason = `Notifications disabled for status: ${newStatus}`;
      } else {
        // 3. Check channels
        if (prefs.webhookNotifications) {
          channels.push("webhook");
        }
        if (prefs.emailNotifications) {
          channels.push("email");
        }
        if (prefs.smsNotifications) {
          channels.push("sms");
        }

        if (channels.length === 0) {
          deliverabilityStatus = "channels_disabled";
          suppressionReason = "All notification channels are disabled";
        }
      }
    }

    // If allowed and channels active, dispatch
    if (deliverabilityStatus === "delivered" && channels.length > 0) {
      if (channels.includes("webhook")) {
        try {
          await dispatchKYCStatusEvent(
            merchantId,
            {
              object_id: applicantId,
              object_type: "applicant",
              applicant_id: applicantId,
              status: newStatus,
              previous_status: previousStatus as any,
              rejection_reasons: rejectionReasons,
              metadata,
            },
            "kyc.status.changed"
          );
        } catch (err: any) {
          logger.warn({ error: err.message, merchantId, userId }, "Failed to dispatch KYC webhook notification");
        }
      }

      if (channels.includes("email")) {
        logger.info({ merchantId, userId, applicantId, newStatus }, "Queued KYC status change email notification");
      }

      if (channels.includes("sms")) {
        logger.info({ merchantId, userId, applicantId, newStatus }, "Queued KYC status change SMS notification");
      }
    }

    const delivered = deliverabilityStatus === "delivered" && channels.length > 0;

    const record: KycStatusNotificationRecord = {
      id: `notif_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      merchantId,
      userId,
      applicantId,
      previousStatus,
      newStatus,
      channels,
      delivered,
      deliverabilityStatus,
      suppressionReason,
      rejectionReasons,
      notifiedAt: new Date(),
      metadata,
    };

    this.notificationHistory.push(record);

    // Log notification deliverability with full structured metadata
    if (!delivered) {
      logger.info(
        {
          notificationId: record.id,
          merchantId,
          userId,
          applicantId,
          newStatus,
          deliverabilityStatus,
          suppressionReason,
        },
        "KYC status notification suppressed due to user preferences"
      );
    } else {
      logger.info(
        {
          notificationId: record.id,
          merchantId,
          userId,
          applicantId,
          newStatus,
          channels,
          deliverabilityStatus,
        },
        "KYC status notification delivered successfully"
      );
    }

    return record;
  }

  /**
   * List notification delivery logs for a merchant or user
   */
  async getNotificationHistory(identifier: string): Promise<KycStatusNotificationRecord[]> {
    return this.notificationHistory.filter(
      (n) => n.merchantId === identifier || n.userId === identifier
    );
  }

  /**
   * Calculate deliverability metrics
   */
  getDeliverabilityMetrics(identifier?: string): DeliverabilityMetrics {
    const records = identifier ? this.notificationHistory.filter(
      (n) => n.merchantId === identifier || n.userId === identifier
    ) : this.notificationHistory;

    const metrics: DeliverabilityMetrics = {
      total: records.length,
      delivered: 0,
      suppressed: 0,
      byStatus: {
        delivered: 0,
        opted_out: 0,
        status_filtered: 0,
        channels_disabled: 0,
        failed: 0,
      },
    };

    for (const record of records) {
      metrics.byStatus[record.deliverabilityStatus] =
        (metrics.byStatus[record.deliverabilityStatus] || 0) + 1;
      if (record.delivered) {
        metrics.delivered++;
      } else {
        metrics.suppressed++;
      }
    }

    return metrics;
  }

  /**
   * Clear notification history (useful in test suites)
   */
  clearHistory(): void {
    this.notificationHistory = [];
    this.preferences.clear();
  }
}

export const kycNotificationService = new KycNotificationService();