import { smsServiceEnhanced } from "./smsEnhanced";
import { smsPreferenceService } from "./smsPreferenceService";
import { smsBillingService } from "./smsBillingService";
import { smsDeliveryTrackingModel } from "../models/smsDeliveryTracking";
import { SmsNotificationTemplates } from "./smsNotificationTemplates";

/**
 * SMS Testing Tools and Utilities
 * 
 * Provides utilities for testing SMS functionality in development and testing environments
 */

export interface SmsTestResult {
  success: boolean;
  trackingId?: string;
  phoneNumber: string;
  timestamp: Date;
  message: string;
  error?: string;
}

export interface SmsSimulationResult {
  sent: number;
  failed: number;
  skipped: number;
  results: SmsTestResult[];
  totalTime: number;
}

/**
 * SMS Test Utility Class
 */
export class SmsTestingUtility {
  /**
   * Send test SMS to a specific phone number
   */
  async sendTestSms(
    phoneNumber: string,
    messageType: string = "test",
    options?: { userId?: string; locale?: string },
  ): Promise<SmsTestResult> {
    const startTime = Date.now();

    try {
      const result = await smsServiceEnhanced.sendSms(
        phoneNumber,
        `Test SMS: ${messageType} at ${new Date().toISOString()}`,
        {
          userId: options?.userId,
          messageType: "alert",
          respectPreferences: false,
          respectRateLimit: false,
        },
      );

      return {
        success: result.sent,
        trackingId: result.trackingId,
        phoneNumber,
        timestamp: new Date(),
        message: result.sent ? "Test SMS sent successfully" : `Test SMS skipped: ${result.skippedReason}`,
        error: result.error,
      };
    } catch (error) {
      return {
        success: false,
        phoneNumber,
        timestamp: new Date(),
        message: "Test SMS failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Log test duration
      const duration = Date.now() - startTime;
      console.log(`[SMS Test] ${phoneNumber} - ${duration}ms`);
    }
  }

  /**
   * Test all transaction notification types
   */
  async testTransactionNotifications(phoneNumber: string): Promise<SmsTestResult[]> {
    const results: SmsTestResult[] = [];

    // Test successful deposit
    results.push(
      await this.sendTestSms(phoneNumber, "deposit_success", { locale: "en" }),
    );

    // Test failed deposit
    results.push(
      await this.sendTestSms(phoneNumber, "deposit_failure", { locale: "en" }),
    );

    // Test successful withdrawal
    results.push(
      await this.sendTestSms(phoneNumber, "withdraw_success", { locale: "en" }),
    );

    // Test failed withdrawal
    results.push(
      await this.sendTestSms(phoneNumber, "withdraw_failure", { locale: "en" }),
    );

    return results;
  }

  /**
   * Test all event notification types
   */
  async testAllNotifications(phoneNumber: string): Promise<SmsTestResult[]> {
    const results: SmsTestResult[] = [];

    const testCases = [
      { type: "kyc_verification_started", locale: "en" },
      { type: "kyc_verification_approved", locale: "en" },
      { type: "dispute_opened", locale: "en" },
      { type: "account_suspended", locale: "en" },
      { type: "suspicious_activity", locale: "en" },
      { type: "otp", locale: "en" },
      { type: "refund_processed", locale: "en" },
      { type: "monthly_statement_ready", locale: "en" },
      { type: "maintenance_notification", locale: "en" },
    ];

    for (const testCase of testCases) {
      results.push(
        await this.sendTestSms(phoneNumber, testCase.type, {
          locale: testCase.locale,
        }),
      );
    }

    return results;
  }

  /**
   * Simulate high-volume SMS sending
   */
  async simulateHighVolume(
    phoneNumbers: string[],
    messagesPerPhone: number = 5,
  ): Promise<SmsSimulationResult> {
    const startTime = Date.now();
    const results: SmsTestResult[] = [];
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const phone of phoneNumbers) {
      for (let i = 0; i < messagesPerPhone; i++) {
        try {
          const result = await this.sendTestSms(phone, `batch_${i + 1}`, {
            respectPreferences: false,
            respectRateLimit: false,
          });

          results.push(result);

          if (result.success) sent++;
          else if (result.error) failed++;
          else skipped++;
        } catch (error) {
          failed++;
          results.push({
            success: false,
            phoneNumber: phone,
            timestamp: new Date(),
            message: "Batch test failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const totalTime = Date.now() - startTime;

    return {
      sent,
      failed,
      skipped,
      results,
      totalTime,
    };
  }

  /**
   * Test rate limiting
   */
  async testRateLimiting(userId: string, phoneNumber: string): Promise<{
    rateLimitTests: Array<{ attempt: number; allowed: boolean; remaining: number }>;
    totalTime: number;
  }> {
    const startTime = Date.now();
    const rateLimitTests: Array<{ attempt: number; allowed: boolean; remaining: number }> = [];

    // Get user's rate limit
    const prefs = await smsPreferenceService.getPreferences(userId);
    const limit = prefs.maxSmsPerHour;

    // Try to send more SMS than the limit
    for (let i = 1; i <= limit + 3; i++) {
      const result = await smsServiceEnhanced.sendSms(phoneNumber, `Rate limit test ${i}`, {
        userId,
        messageType: "alert",
        respectPreferences: false,
        respectRateLimit: true, // Enforce rate limit
      });

      const rateLimitStatus = await smsServiceEnhanced.getRateLimitStatus(userId);

      rateLimitTests.push({
        attempt: i,
        allowed: result.sent,
        remaining: Math.max(0, limit - rateLimitStatus.currentCount),
      });
    }

    const totalTime = Date.now() - startTime;

    return {
      rateLimitTests,
      totalTime,
    };
  }

  /**
   * Test user preferences
   */
  async testUserPreferences(userId: string): Promise<{
    enabled: boolean;
    optOut: boolean;
    preferences: Record<string, boolean>;
  }> {
    const prefs = await smsPreferenceService.getPreferences(userId);

    return {
      enabled: prefs.enabled,
      optOut: prefs.optOut,
      preferences: {
        notifyDepositSuccess: prefs.notifyDepositSuccess,
        notifyDepositFailure: prefs.notifyDepositFailure,
        notifyWithdrawSuccess: prefs.notifyWithdrawSuccess,
        notifyWithdrawFailure: prefs.notifyWithdrawFailure,
        notifyDisputeUpdates: prefs.notifyDisputeUpdates,
        notifyKycUpdates: prefs.notifyKycUpdates,
      },
    };
  }

  /**
   * Test delivery tracking
   */
  async testDeliveryTracking(userId: string): Promise<{
    stats: {
      totalSent: number;
      totalDelivered: number;
      totalFailed: number;
      successRate: number;
    };
    recentSms: Array<{
      id: string;
      status: string;
      messageType: string;
      createdAt: Date;
    }>;
  }> {
    const stats = await smsDeliveryTrackingModel.getUserStats(userId);
    const recentSms = await smsDeliveryTrackingModel.findByUserId(userId, 10, 0);

    return {
      stats,
      recentSms: recentSms.map((sms) => ({
        id: sms.id,
        status: sms.status,
        messageType: sms.messageType,
        createdAt: sms.createdAt,
      })),
    };
  }

  /**
   * Test cost tracking
   */
  async testCostTracking(userId: string): Promise<{
    costSummary: {
      totalCost: number;
      successfulSmsCost: number;
      failedSmsCost: number;
      period: { start: Date; end: Date };
    };
    monthlyBilling?: {
      smsSent: number;
      totalCost: number;
      costPerSms: number;
    };
  }> {
    const costSummary = await smsPreferenceService.getCostSummary(userId);

    const monthlyBilling = await smsBillingService.getUserMonthlyBilling(userId);

    return {
      costSummary,
      monthlyBilling: monthlyBilling
        ? {
            smsSent: monthlyBilling.smsSentCount,
            totalCost: monthlyBilling.totalCostUsd,
            costPerSms: monthlyBilling.totalCostUsd / Math.max(1, monthlyBilling.smsSentCount),
          }
        : undefined,
    };
  }

  /**
   * Test quiet hours
   */
  async testQuietHours(userId: string): Promise<{
    quietHoursEnabled: boolean;
    quietHoursStart?: number;
    quietHoursEnd?: number;
    currentHour: number;
    inQuietHours: boolean;
  }> {
    const prefs = await smsPreferenceService.getPreferences(userId);
    const inQuietHours = await smsServiceEnhanced.isInQuietHours(userId);
    const now = new Date();

    return {
      quietHoursEnabled: prefs.quietHoursStart !== undefined && prefs.quietHoursEnd !== undefined,
      quietHoursStart: prefs.quietHoursStart,
      quietHoursEnd: prefs.quietHoursEnd,
      currentHour: now.getUTCHours(),
      inQuietHours,
    };
  }

  /**
   * Generate comprehensive SMS test report
   */
  async generateTestReport(
    userId: string,
    phoneNumber: string,
  ): Promise<{
    timestamp: Date;
    userId: string;
    phoneNumber: string;
    tests: Record<string, any>;
    summary: {
      passed: number;
      failed: number;
      warnings: string[];
    };
  }> {
    const results: Record<string, any> = {};
    const warnings: string[] = [];

    // Test preferences
    results.preferences = await this.testUserPreferences(userId);

    // Test quiet hours
    results.quietHours = await this.testQuietHours(userId);

    // Test delivery tracking
    results.deliveryTracking = await this.testDeliveryTracking(userId);

    // Test cost tracking
    results.costTracking = await this.testCostTracking(userId);

    // Test single SMS
    const testSmsResult = await this.sendTestSms(phoneNumber, "report_generation", { userId });
    results.testSms = testSmsResult;

    // Count results
    let passed = 0;
    let failed = 0;

    if (results.testSms.success) passed++;
    else {
      failed++;
      warnings.push(`Failed to send test SMS: ${results.testSms.error}`);
    }

    if (!results.preferences.enabled) {
      warnings.push("SMS notifications are disabled for this user");
    }

    if (results.preferences.optOut) {
      warnings.push("User has opted out of SMS notifications");
    }

    if (results.quietHours.inQuietHours) {
      warnings.push("Currently in quiet hours - SMS may not be delivered");
    }

    return {
      timestamp: new Date(),
      userId,
      phoneNumber,
      tests: results,
      summary: {
        passed,
        failed,
        warnings,
      },
    };
  }
}

/**
 * SMS Mock Service (for testing without actual SMS delivery)
 */
export class SmsMockService {
  private sentMessages: Array<{
    phoneNumber: string;
    message: string;
    timestamp: Date;
    metadata?: Record<string, any>;
  }> = [];

  /**
   * Record a mock SMS send
   */
  recordSend(
    phoneNumber: string,
    message: string,
    metadata?: Record<string, any>,
  ): void {
    this.sentMessages.push({
      phoneNumber,
      message,
      timestamp: new Date(),
      metadata,
    });
  }

  /**
   * Get all sent messages
   */
  getSentMessages(): typeof this.sentMessages {
    return this.sentMessages;
  }

  /**
   * Get messages sent to a specific phone
   */
  getMessagesByPhone(phoneNumber: string): typeof this.sentMessages {
    return this.sentMessages.filter((msg) => msg.phoneNumber === phoneNumber);
  }

  /**
   * Get message count
   */
  getMessageCount(): number {
    return this.sentMessages.length;
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.sentMessages = [];
  }

  /**
   * Export messages as JSON
   */
  exportAsJson(): string {
    return JSON.stringify(this.sentMessages, null, 2);
  }
}

export const smsTestingUtility = new SmsTestingUtility();
export const smsMockService = new SmsMockService();
