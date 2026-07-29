import { resolveLocale, translate } from "../utils/i18n";

/**
 * SMS Notification Templates
 * 
 * Provides pre-built message templates for various transaction and system events.
 * All templates are i18n-aware and support multiple languages.
 */

export interface SmsTemplateContext {
  locale?: string;
  [key: string]: any;
}

export class SmsNotificationTemplates {
  /**
   * Transaction success notification
   */
  static transactionSuccess(context: SmsTemplateContext & {
    transactionType: "deposit" | "withdraw";
    amount: string;
    provider: string;
    referenceNumber: string;
  }): string {
    const locale = resolveLocale(context.locale);
    const action = translate(`sms.action.${context.transactionType}`, locale);
    
    return translate("sms.transaction_completed", locale, {
      action,
      amount: context.amount,
      provider: context.provider.toUpperCase(),
      referenceNumber: context.referenceNumber,
    });
  }

  /**
   * Transaction failure notification
   */
  static transactionFailure(context: SmsTemplateContext & {
    transactionType: "deposit" | "withdraw";
    referenceNumber: string;
    reason?: string;
  }): string {
    const locale = resolveLocale(context.locale);
    const action = translate(`sms.action.${context.transactionType}`, locale);
    
    const detail = context.reason
      ? translate("sms.reason_detail", locale, {
          reason: context.reason.slice(0, 100),
        })
      : "";

    return translate("sms.transaction_failed", locale, {
      action,
      referenceNumber: context.referenceNumber,
      detail,
    });
  }

  /**
   * KYC verification started
   */
  static kycVerificationStarted(context: SmsTemplateContext): string {
    const locale = resolveLocale(context.locale);
    return translate("sms.kyc_verification_started", locale, {});
  }

  /**
   * KYC verification approved
   */
  static kycVerificationApproved(context: SmsTemplateContext & {
    kycLevel: string;
  }): string {
    const locale = resolveLocale(context.locale);
    const levelName = translate(`sms.kyc_level_${context.kycLevel}`, locale);
    
    return translate("sms.kyc_verification_approved", locale, {
      kycLevel: levelName,
    });
  }

  /**
   * KYC verification rejected
   */
  static kycVerificationRejected(context: SmsTemplateContext & {
    reason?: string;
  }): string {
    const locale = resolveLocale(context.locale);
    const reasonText = context.reason
      ? translate("sms.kyc_rejection_reason", locale, {
          reason: context.reason.slice(0, 80),
        })
      : "";

    return translate("sms.kyc_verification_rejected", locale, { reason: reasonText });
  }

  /**
   * Dispute opened notification
   */
  static disputeOpened(context: SmsTemplateContext & {
    transactionReference: string;
    amount: string;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.dispute_opened", locale, {
      transactionReference: context.transactionReference,
      amount: context.amount,
    });
  }

  /**
   * Dispute resolved (upheld)
   */
  static disputeUpheld(context: SmsTemplateContext & {
    transactionReference: string;
    amount: string;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.dispute_upheld", locale, {
      transactionReference: context.transactionReference,
      amount: context.amount,
    });
  }

  /**
   * Dispute resolved (rejected)
   */
  static disputeRejected(context: SmsTemplateContext & {
    transactionReference: string;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.dispute_rejected", locale, {
      transactionReference: context.transactionReference,
    });
  }

  /**
   * Transaction limit increased
   */
  static limitIncreased(context: SmsTemplateContext & {
    newLimit: string;
    currency: string;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.limit_increased", locale, {
      newLimit: context.newLimit,
      currency: context.currency.toUpperCase(),
    });
  }

  /**
   * Transaction limit reached
   */
  static limitReached(context: SmsTemplateContext & {
    currentLimit: string;
    currency: string;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.limit_reached", locale, {
      currentLimit: context.currentLimit,
      currency: context.currency.toUpperCase(),
    });
  }

  /**
   * Account suspended
   */
  static accountSuspended(context: SmsTemplateContext & {
    reason?: string;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.account_suspended", locale, {
      reason: context.reason || "",
    });
  }

  /**
   * Account reactivated
   */
  static accountReactivated(context: SmsTemplateContext): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.account_reactivated", locale, {});
  }

  /**
   * Suspicious activity detected
   */
  static suspiciousActivity(context: SmsTemplateContext & {
    activityType: string;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.suspicious_activity", locale, {
      activityType: translate(`sms.activity_type_${context.activityType}`, locale),
    });
  }

  /**
   * Withdrawal retry notification
   */
  static withdrawalRetry(context: SmsTemplateContext & {
    transactionReference: string;
    retryCount: number;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.withdrawal_retry", locale, {
      transactionReference: context.transactionReference,
      retryCount: context.retryCount.toString(),
    });
  }

  /**
   * One-time password (OTP) for sensitive operations
   */
  static otp(context: SmsTemplateContext & {
    otp: string;
    expiresIn?: number;
  }): string {
    const locale = resolveLocale(context.locale);
    const expiryText = context.expiresIn
      ? translate("sms.otp_expires", locale, {
          expiresIn: context.expiresIn.toString(),
        })
      : "";

    return translate("sms.otp", locale, {
      otp: context.otp,
      expiresIn: expiryText,
    });
  }

  /**
   * Account verification required
   */
  static verificationRequired(context: SmsTemplateContext & {
    verifyUrl?: string;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.verification_required", locale, {
      verifyUrl: context.verifyUrl || "",
    });
  }

  /**
   * New device login
   */
  static newDeviceLogin(context: SmsTemplateContext & {
    deviceInfo?: string;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.new_device_login", locale, {
      deviceInfo: context.deviceInfo || "unknown device",
    });
  }

  /**
   * Refund processed
   */
  static refundProcessed(context: SmsTemplateContext & {
    amount: string;
    currency: string;
    referenceNumber: string;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.refund_processed", locale, {
      amount: context.amount,
      currency: context.currency.toUpperCase(),
      referenceNumber: context.referenceNumber,
    });
  }

  /**
   * Monthly statement available
   */
  static monthlyStatementReady(context: SmsTemplateContext & {
    month: string;
    totalTransactions: number;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.monthly_statement_ready", locale, {
      month: context.month,
      totalTransactions: context.totalTransactions.toString(),
    });
  }

  /**
   * Provider maintenance notification
   */
  static maintenanceNotification(context: SmsTemplateContext & {
    provider: string;
    duration?: string;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.maintenance_notification", locale, {
      provider: context.provider.toUpperCase(),
      duration: context.duration || "soon",
    });
  }

  /**
   * Rate limit warning
   */
  static rateLimitWarning(context: SmsTemplateContext & {
    remaining: number;
    limit: number;
  }): string {
    const locale = resolveLocale(context.locale);
    
    return translate("sms.rate_limit_warning", locale, {
      remaining: context.remaining.toString(),
      limit: context.limit.toString(),
    });
  }
}

/**
 * SMS Template Builder for custom messages
 */
export class SmsTemplateBuilder {
  private template: string;
  private variables: Record<string, string> = {};

  constructor(template: string) {
    this.template = template;
  }

  /**
   * Set a template variable
   */
  setVariable(name: string, value: string): this {
    this.variables[name] = value;
    return this;
  }

  /**
   * Set multiple template variables
   */
  setVariables(vars: Record<string, string>): this {
    this.variables = { ...this.variables, ...vars };
    return this;
  }

  /**
   * Render the template
   */
  render(): string {
    let result = this.template;
    for (const [key, value] of Object.entries(this.variables)) {
      result = result.replace(new RegExp(`{{${key}}}`, "g"), value);
    }
    return result;
  }

  /**
   * Add prefix to template
   */
  withPrefix(prefix: string): this {
    this.template = `${prefix} ${this.template}`;
    return this;
  }

  /**
   * Add suffix to template
   */
  withSuffix(suffix: string): this {
    this.template = `${this.template} ${suffix}`;
    return this;
  }

  /**
   * Truncate to max length with ellipsis
   */
  truncate(maxLength: number): this {
    if (this.template.length > maxLength) {
      this.template = this.template.substring(0, maxLength - 3) + "...";
    }
    return this;
  }
}
