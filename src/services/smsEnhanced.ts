import twilio from "twilio";
// @ts-ignore
import africastalking from "africastalking";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { resolveLocale, translate } from "../utils/i18n";
import { smsDeliveryTrackingModel, type SmsDeliveryTracking } from "../models/smsDeliveryTracking";
import { smsPreferencesModel } from "../models/smsPreferences";
import { redis } from "../config/redis";

export type SmsEventKind = "transaction_completed" | "transaction_failed";
export type SmsMessageType = "transaction_success" | "transaction_failure" | "kyc_update" | "dispute_update" | "alert";

export interface TransactionSmsContext {
  referenceNumber: string;
  type: "deposit" | "withdraw";
  amount: string;
  provider: string;
  kind: SmsEventKind;
  errorMessage?: string;
  locale?: string;
}

export interface SmsSendResult {
  sent: boolean;
  trackingId?: string;
  skippedReason?: string;
  messageSid?: string;
  error?: string;
  costUsd?: number;
}

export interface SmsRateLimitStatus {
  currentCount: number;
  limit: number;
  resetAt: Date;
  canSend: boolean;
}

/**
 * SMS Pricing configuration
 */
const SMS_PRICING: Record<string, number> = {
  twilio: 0.0075, // $0.0075 per SMS
  africastalking: 0.005, // $0.005 per SMS
  default: 0.01, // $0.01 fallback
};

/**
 * Normalize phone number to E.164 format
 */
export function formatPhoneE164(
  raw: string,
  defaultRegion: CountryCode = (process.env.SMS_DEFAULT_REGION as CountryCode) || "CM",
): string {
  const trimmed = raw.trim();
  const parsed = parsePhoneNumberFromString(trimmed, defaultRegion);
  if (!parsed || !parsed.isValid()) {
    throw new Error(`Invalid phone number for SMS: ${raw}`);
  }
  return parsed.number; // E.164
}

/**
 * Build SMS templates
 */
function templateCompleted(ctx: TransactionSmsContext): string {
  const locale = resolveLocale(ctx.locale);
  const action = translate(`sms.action.${ctx.type}`, locale);
  return translate("sms.transaction_completed", locale, {
    action,
    amount: ctx.amount,
    provider: ctx.provider.toUpperCase(),
    referenceNumber: ctx.referenceNumber,
  });
}

function templateFailed(ctx: TransactionSmsContext): string {
  const locale = resolveLocale(ctx.locale);
  const action = translate(`sms.action.${ctx.type}`, locale);
  const detail = ctx.errorMessage
    ? translate("sms.reason_detail", locale, {
        reason: ctx.errorMessage.slice(0, 120),
      })
    : "";

  return translate("sms.transaction_failed", locale, {
    action,
    referenceNumber: ctx.referenceNumber,
    detail,
  });
}

function templateKycUpdate(status: string, locale?: string): string {
  return translate("sms.kyc_update", resolveLocale(locale), {
    status: translate(`kyc.status.${status}`, resolveLocale(locale)),
  });
}

function templateDisputeUpdate(disputeStatus: string, locale?: string): string {
  return translate("sms.dispute_update", resolveLocale(locale), {
    status: translate(`dispute.status.${disputeStatus}`, resolveLocale(locale)),
  });
}

export function buildTransactionSmsBody(ctx: TransactionSmsContext): string {
  return ctx.kind === "transaction_completed"
    ? templateCompleted(ctx)
    : templateFailed(ctx);
}

/**
 * Enhanced SMS Service with delivery tracking, rate limiting, and cost tracking
 */
export class SmsServiceEnhanced {
  private twilioClient: ReturnType<typeof twilio> | null = null;
  private atClient: any = null;
  private provider: string;

  constructor() {
    this.provider = (process.env.SMS_PROVIDER || "none").toLowerCase();
    if (this.provider === "twilio") {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      if (sid && token) this.twilioClient = twilio(sid, token);
    } else if (this.provider === "africastalking") {
      const apiKey = process.env.AFRICASTALKING_API_KEY;
      const username = process.env.AFRICASTALKING_USERNAME;
      if (apiKey && username) {
        this.atClient = africastalking({ apiKey, username });
      }
    }
  }

  shouldSend(): boolean {
    if (process.env.NODE_ENV === "test") return false;
    if (this.provider === "none" || this.provider === "off" || this.provider === "disabled")
      return false;
    return (
      (this.provider === "twilio" && this.twilioClient !== null) ||
      (this.provider === "africastalking" && this.atClient !== null)
    );
  }

  /**
   * Get SMS pricing for the configured provider
   */
  getSmsPrice(): number {
    return SMS_PRICING[this.provider] || SMS_PRICING.default;
  }

  /**
   * Get rate limit status for a user (hourly limit)
   */
  async getRateLimitStatus(userId: string): Promise<SmsRateLimitStatus> {
    const prefs = await smsPreferencesModel.findByUserId(userId);
    const limit = prefs?.maxSmsPerHour || 5;

    // Redis key for hourly rate limit
    const now = new Date();
    const hourKey = `sms:ratelimit:${userId}:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}`;

    const count = parseInt(await redis.get(hourKey) || "0", 10);
    const resetAt = new Date(now);
    resetAt.setUTCHours(resetAt.getUTCHours() + 1, 0, 0, 0);

    return {
      currentCount: count,
      limit,
      resetAt,
      canSend: count < limit,
    };
  }

  /**
   * Check quiet hours for user
   */
  async isInQuietHours(userId: string): Promise<boolean> {
    const prefs = await smsPreferencesModel.findByUserId(userId);
    if (!prefs || prefs.quietHoursStart === undefined || prefs.quietHoursEnd === undefined) {
      return false;
    }

    const now = new Date();
    const currentHour = now.getUTCHours();

    // Handle cases where quiet hours wrap around midnight
    if (prefs.quietHoursStart <= prefs.quietHoursEnd) {
      return currentHour >= prefs.quietHoursStart && currentHour < prefs.quietHoursEnd;
    } else {
      return currentHour >= prefs.quietHoursStart || currentHour < prefs.quietHoursEnd;
    }
  }

  /**
   * Send SMS with full tracking, rate limiting, and cost calculation
   */
  async sendSms(
    phoneNumber: string,
    body: string,
    {
      userId,
      transactionId,
      messageType = "alert",
      respectPreferences = true,
      respectRateLimit = true,
    }: {
      userId?: string;
      transactionId?: string;
      messageType?: SmsMessageType;
      respectPreferences?: boolean;
      respectRateLimit?: boolean;
    } = {},
  ): Promise<SmsSendResult> {
    let to: string;
    try {
      to = formatPhoneE164(phoneNumber);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[sms-enhanced] invalid recipient", msg);
      return { sent: false, skippedReason: "invalid_phone", error: msg };
    }

    // Create tracking record
    const tracking = await smsDeliveryTrackingModel.createRecord({
      userId,
      transactionId,
      phoneNumber: to,
      messageContent: body,
      messageType,
      provider: this.provider,
    });

    try {
      // Check if SMS sending is enabled
      if (!this.shouldSend()) {
        console.log("[sms-enhanced] skipped (disabled or test env)");
        await smsDeliveryTrackingModel.updateStatus(tracking.id, "skipped", {
          statusReason: "sms_provider_disabled",
        });
        return { sent: false, trackingId: tracking.id, skippedReason: "disabled_or_test" };
      }

      // Check user preferences
      if (userId && respectPreferences) {
        const canReceive = await smsPreferencesModel.canReceiveSms(userId);
        if (!canReceive) {
          await smsDeliveryTrackingModel.updateStatus(tracking.id, "skipped", {
            statusReason: "user_opted_out_or_disabled",
          });
          return { sent: false, trackingId: tracking.id, skippedReason: "user_opted_out" };
        }

        // Check quiet hours
        if (await this.isInQuietHours(userId)) {
          await smsDeliveryTrackingModel.updateStatus(tracking.id, "skipped", {
            statusReason: "quiet_hours",
          });
          return { sent: false, trackingId: tracking.id, skippedReason: "quiet_hours" };
        }
      }

      // Check rate limit
      if (userId && respectRateLimit) {
        const rateLimit = await this.getRateLimitStatus(userId);
        if (!rateLimit.canSend) {
          await smsDeliveryTrackingModel.updateStatus(tracking.id, "skipped", {
            statusReason: "rate_limit_exceeded",
          });
          return { sent: false, trackingId: tracking.id, skippedReason: "rate_limited" };
        }
      }

      // Validate configuration
      if (!process.env.TWILIO_PHONE_NUMBER && this.provider === "twilio") {
        console.warn("[sms-enhanced] TWILIO_PHONE_NUMBER not set");
        await smsDeliveryTrackingModel.updateStatus(tracking.id, "failed", {
          statusReason: "missing_from_number",
        });
        return { sent: false, trackingId: tracking.id, skippedReason: "missing_from_number", error: "SMS provider not configured" };
      }

      // Send SMS
      let messageSid = "unknown";
      const costUsd = this.getSmsPrice();

      if (this.provider === "twilio") {
        const message = await this.twilioClient!.messages.create({
          to,
          from: process.env.TWILIO_PHONE_NUMBER!,
          body,
        });
        messageSid = message.sid;
        console.log("[sms-enhanced] sent via Twilio", {
          to,
          sid: message.sid,
          status: message.status,
        });

        // Update tracking
        await smsDeliveryTrackingModel.updateStatus(tracking.id, "sent", {
          providerMessageId: messageSid,
          sentAt: new Date(),
        });
        await smsDeliveryTrackingModel.recordCost(tracking.id, costUsd);
      } else if (this.provider === "africastalking") {
        const result = await this.atClient.SMS.send({
          to: [to],
          message: body,
          from: process.env.AFRICASTALKING_SENDER_ID || "PROXYPAY",
        });

        const msgData = result?.SMSMessageData?.Recipients?.[0];
        if (msgData?.status === "Success") {
          messageSid = msgData.messageId;
          await smsDeliveryTrackingModel.updateStatus(tracking.id, "sent", {
            providerMessageId: messageSid,
            sentAt: new Date(),
          });
          await smsDeliveryTrackingModel.recordCost(tracking.id, costUsd);
        } else {
          throw new Error(`Africa's Talking sending failed with status: ${msgData?.status}`);
        }
      }

      // Increment rate limit counter in Redis
      if (userId) {
        const now = new Date();
        const hourKey = `sms:ratelimit:${userId}:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}`;
        await redis.incr(hourKey);
        await redis.expire(hourKey, 3600); // 1 hour
      }

      return {
        sent: true,
        trackingId: tracking.id,
        messageSid,
        costUsd,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sms-enhanced] send failed", { to, error: msg });

      await smsDeliveryTrackingModel.updateStatus(tracking.id, "failed", {
        statusReason: msg,
        failedAt: new Date(),
      });

      return {
        sent: false,
        trackingId: tracking.id,
        error: msg,
      };
    }
  }

  /**
   * Send transaction notification
   */
  async notifyTransactionEvent(
    phoneNumber: string,
    ctx: TransactionSmsContext,
    { userId, transactionId }: { userId?: string; transactionId?: string } = {},
  ): Promise<SmsSendResult> {
    const body = buildTransactionSmsBody(ctx);
    const messageType = ctx.kind === "transaction_completed" ? "transaction_success" : "transaction_failure";

    return this.sendSms(phoneNumber, body, {
      userId,
      transactionId,
      messageType,
    });
  }

  /**
   * Send KYC status notification
   */
  async notifyKycUpdate(
    phoneNumber: string,
    kycStatus: string,
    { userId, locale }: { userId?: string; locale?: string } = {},
  ): Promise<SmsSendResult> {
    const body = templateKycUpdate(kycStatus, locale);
    return this.sendSms(phoneNumber, body, {
      userId,
      messageType: "kyc_update",
    });
  }

  /**
   * Send dispute update notification
   */
  async notifyDisputeUpdate(
    phoneNumber: string,
    disputeStatus: string,
    { userId, transactionId, locale }: { userId?: string; transactionId?: string; locale?: string } = {},
  ): Promise<SmsSendResult> {
    const body = templateDisputeUpdate(disputeStatus, locale);
    return this.sendSms(phoneNumber, body, {
      userId,
      transactionId,
      messageType: "dispute_update",
    });
  }

  /**
   * Send generic alert SMS
   */
  async sendAlert(
    phoneNumber: string,
    message: string,
    { userId }: { userId?: string } = {},
  ): Promise<SmsSendResult> {
    return this.sendSms(phoneNumber, message, {
      userId,
      messageType: "alert",
    });
  }

  /**
   * Process pending SMS retries
   */
  async processPendingRetries(): Promise<{ processed: number; successful: number; failed: number }> {
    const pendingRecords = await smsDeliveryTrackingModel.findPendingForRetry();
    let successful = 0;
    let failed = 0;

    for (const record of pendingRecords) {
      try {
        const result = await this.sendSms(record.phoneNumber, record.messageContent, {
          userId: record.userId,
          transactionId: record.transactionId,
          messageType: record.messageType as SmsMessageType,
          respectPreferences: false, // Retry should bypass preferences check
          respectRateLimit: false,   // Retry should bypass rate limit
        });

        if (result.sent) {
          successful++;
        } else {
          failed++;
          // Increment retry count
          await smsDeliveryTrackingModel.incrementRetry(record.id);
        }
      } catch (error) {
        console.error(`Failed to retry SMS ${record.id}:`, error);
        failed++;
      }
    }

    return {
      processed: pendingRecords.length,
      successful,
      failed,
    };
  }
}

export const smsServiceEnhanced = new SmsServiceEnhanced();
