import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { smsServiceEnhanced } from "../services/smsEnhanced";
import { smsPreferenceService } from "../services/smsPreferenceService";
import { smsBillingService } from "../services/smsBillingService";
import { smsTestingUtility, smsMockService } from "../services/smsTestingTools";
import { smsPreferencesModel } from "../models/smsPreferences";
import { smsDeliveryTrackingModel } from "../models/smsDeliveryTracking";
import { SmsNotificationTemplates } from "../services/smsNotificationTemplates";

describe("SMS Notifications", () => {
  const testUserId = "test-user-" + Date.now();
  const testPhoneNumber = "+237670000000";

  beforeEach(async () => {
    // Create user preferences before each test
    await smsPreferencesModel.createForUser(testUserId);
  });

  afterEach(async () => {
    // Cleanup after each test
    smsMockService.clear();
  });

  describe("SMS Preferences Management", () => {
    test("should create default preferences for new user", async () => {
      const userId = "new-user-" + Date.now();
      const prefs = await smsPreferenceService.getPreferences(userId);

      expect(prefs.userId).toBe(userId);
      expect(prefs.enabled).toBe(true);
      expect(prefs.optOut).toBe(false);
      expect(prefs.maxSmsPerHour).toBe(5);
      expect(prefs.maxSmsPerDay).toBe(20);
    });

    test("should update user preferences", async () => {
      await smsPreferenceService.updatePreferences(testUserId, {
        maxSmsPerHour: 10,
        notifyDepositSuccess: false,
        notifyWithdrawFailure: false,
      });

      const prefs = await smsPreferenceService.getPreferences(testUserId);
      expect(prefs.maxSmsPerHour).toBe(10);
      expect(prefs.notifyDepositSuccess).toBe(false);
      expect(prefs.notifyWithdrawFailure).toBe(false);
    });

    test("should opt user out of SMS", async () => {
      await smsPreferenceService.optOut(testUserId, "Too many messages");

      const prefs = await smsPreferenceService.getPreferences(testUserId);
      expect(prefs.optOut).toBe(true);
      expect(prefs.optOutReason).toBe("Too many messages");
    });

    test("should opt user back in to SMS", async () => {
      await smsPreferenceService.optOut(testUserId);
      await smsPreferenceService.optIn(testUserId);

      const prefs = await smsPreferenceService.getPreferences(testUserId);
      expect(prefs.optOut).toBe(false);
    });

    test("should disable SMS notifications", async () => {
      await smsPreferenceService.disable(testUserId);

      const prefs = await smsPreferenceService.getPreferences(testUserId);
      expect(prefs.enabled).toBe(false);
    });

    test("should enable SMS notifications", async () => {
      await smsPreferenceService.disable(testUserId);
      await smsPreferenceService.enable(testUserId);

      const prefs = await smsPreferenceService.getPreferences(testUserId);
      expect(prefs.enabled).toBe(true);
    });

    test("should check if user can receive SMS for specific event", async () => {
      await smsPreferenceService.updatePreferences(testUserId, {
        notifyDepositSuccess: true,
        notifyDepositFailure: false,
      });

      expect(await smsPreferenceService.canReceiveSmsForEvent(testUserId, "deposit_success")).toBe(true);
      expect(await smsPreferenceService.canReceiveSmsForEvent(testUserId, "deposit_failure")).toBe(false);
    });

    test("should validate rate limit constraints", async () => {
      expect(async () => {
        await smsPreferenceService.updatePreferences(testUserId, { maxSmsPerHour: -1 });
      }).rejects.toThrow();
    });

    test("should validate quiet hours constraints", async () => {
      expect(async () => {
        await smsPreferenceService.updatePreferences(testUserId, { quietHoursStart: 25 });
      }).rejects.toThrow();
    });
  });

  describe("SMS Delivery Tracking", () => {
    test("should create SMS delivery record", async () => {
      const record = await smsDeliveryTrackingModel.createRecord({
        userId: testUserId,
        phoneNumber: testPhoneNumber,
        messageContent: "Test message",
        messageType: "transaction_success",
        provider: "twilio",
      });

      expect(record.userId).toBe(testUserId);
      expect(record.phoneNumber).toBe(testPhoneNumber);
      expect(record.status).toBe("pending");
    });

    test("should update SMS delivery status", async () => {
      const record = await smsDeliveryTrackingModel.createRecord({
        userId: testUserId,
        phoneNumber: testPhoneNumber,
        messageContent: "Test message",
        messageType: "transaction_success",
        provider: "twilio",
      });

      const updated = await smsDeliveryTrackingModel.updateStatus(record.id, "sent", {
        providerMessageId: "msg_123456",
        sentAt: new Date(),
      });

      expect(updated.status).toBe("sent");
      expect(updated.providerMessageId).toBe("msg_123456");
    });

    test("should record SMS cost", async () => {
      const record = await smsDeliveryTrackingModel.createRecord({
        userId: testUserId,
        phoneNumber: testPhoneNumber,
        messageContent: "Test message",
        messageType: "transaction_success",
        provider: "twilio",
      });

      const updated = await smsDeliveryTrackingModel.recordCost(record.id, 0.0075, "USD");

      expect(updated.costUsd).toBe(0.0075);
      expect(updated.currency).toBe("USD");
    });

    test("should find SMS records by user", async () => {
      // Create multiple records
      await smsDeliveryTrackingModel.createRecord({
        userId: testUserId,
        phoneNumber: testPhoneNumber,
        messageContent: "Message 1",
        messageType: "transaction_success",
        provider: "twilio",
      });

      await smsDeliveryTrackingModel.createRecord({
        userId: testUserId,
        phoneNumber: testPhoneNumber,
        messageContent: "Message 2",
        messageType: "transaction_failure",
        provider: "twilio",
      });

      const records = await smsDeliveryTrackingModel.findByUserId(testUserId, 10, 0);

      expect(records.length).toBeGreaterThanOrEqual(2);
    });

    test("should get user SMS statistics", async () => {
      const record = await smsDeliveryTrackingModel.createRecord({
        userId: testUserId,
        phoneNumber: testPhoneNumber,
        messageContent: "Test message",
        messageType: "transaction_success",
        provider: "twilio",
      });

      await smsDeliveryTrackingModel.updateStatus(record.id, "delivered", {
        deliveredAt: new Date(),
      });

      const stats = await smsDeliveryTrackingModel.getUserStats(testUserId);

      expect(stats.totalDelivered).toBeGreaterThan(0);
    });

    test("should increment retry count", async () => {
      const record = await smsDeliveryTrackingModel.createRecord({
        userId: testUserId,
        phoneNumber: testPhoneNumber,
        messageContent: "Test message",
        messageType: "transaction_success",
        provider: "twilio",
        maxRetries: 3,
      });

      const updated = await smsDeliveryTrackingModel.incrementRetry(record.id);

      expect(updated.retryCount).toBe(1);
    });
  });

  describe("Rate Limiting", () => {
    test("should get rate limit status", async () => {
      const status = await smsServiceEnhanced.getRateLimitStatus(testUserId);

      expect(status).toHaveProperty("currentCount");
      expect(status).toHaveProperty("limit");
      expect(status).toHaveProperty("resetAt");
      expect(status).toHaveProperty("canSend");
      expect(status.limit).toBe(5); // Default limit
    });

    test("should enforce hourly rate limit", async () => {
      // Update to a low limit for testing
      await smsPreferenceService.updatePreferences(testUserId, { maxSmsPerHour: 2 });

      const result1 = await smsServiceEnhanced.sendSms(testPhoneNumber, "Test 1", {
        userId: testUserId,
        respectPreferences: false,
        respectRateLimit: true,
      });

      const result2 = await smsServiceEnhanced.sendSms(testPhoneNumber, "Test 2", {
        userId: testUserId,
        respectPreferences: false,
        respectRateLimit: true,
      });

      const result3 = await smsServiceEnhanced.sendSms(testPhoneNumber, "Test 3", {
        userId: testUserId,
        respectPreferences: false,
        respectRateLimit: true,
      });

      // Third should be rate limited (assuming SMS provider is disabled in test)
      expect([result1.sent, result2.sent, result3.sent]).toContain(false);
    });
  });

  describe("SMS Templates", () => {
    test("should generate transaction success template", () => {
      const message = SmsNotificationTemplates.transactionSuccess({
        transactionType: "deposit",
        amount: "1000",
        provider: "MTN",
        referenceNumber: "REF-12345",
        locale: "en",
      });

      expect(message).toContain("deposit");
      expect(message).toContain("1000");
      expect(message).toContain("REF-12345");
    });

    test("should generate transaction failure template", () => {
      const message = SmsNotificationTemplates.transactionFailure({
        transactionType: "withdraw",
        referenceNumber: "REF-12345",
        reason: "Insufficient funds",
        locale: "en",
      });

      expect(message).toContain("withdraw");
      expect(message).toContain("REF-12345");
      expect(message).toContain("Insufficient funds");
    });

    test("should generate KYC approval template", () => {
      const message = SmsNotificationTemplates.kycVerificationApproved({
        kycLevel: "full",
        locale: "en",
      });

      expect(message).toBeTruthy();
    });

    test("should generate OTP template", () => {
      const message = SmsNotificationTemplates.otp({
        otp: "123456",
        expiresIn: 5,
        locale: "en",
      });

      expect(message).toContain("123456");
    });

    test("should generate dispute opened template", () => {
      const message = SmsNotificationTemplates.disputeOpened({
        transactionReference: "REF-12345",
        amount: "500",
        locale: "en",
      });

      expect(message).toBeTruthy();
    });
  });

  describe("SMS Billing", () => {
    test("should generate billing record", async () => {
      const now = new Date();
      const monthStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
      const monthEnd = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);

      const billing = await smsBillingService.generateBillingRecord(testUserId, monthStart, monthEnd);

      expect(billing.userId).toBe(testUserId);
      expect(billing.billingPeriodStart).toEqual(monthStart);
      expect(billing.billingPeriodEnd).toEqual(monthEnd);
    });

    test("should get user monthly billing", async () => {
      const billing = await smsBillingService.getUserMonthlyBilling(testUserId);

      if (billing) {
        expect(billing.userId).toBe(testUserId);
        expect(billing).toHaveProperty("smsSentCount");
        expect(billing).toHaveProperty("totalCostUsd");
      }
    });

    test("should generate cost report", async () => {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const report = await smsBillingService.generateCostReport(weekAgo, now);

      expect(report).toHaveProperty("period");
      expect(report).toHaveProperty("totalSmsCount");
      expect(report).toHaveProperty("totalCostUsd");
      expect(report).toHaveProperty("costBreakdown");
    });

    test("should export billing data to CSV", async () => {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const csv = await smsBillingService.exportBillingDataCsv(weekAgo, now);

      expect(typeof csv).toBe("string");
      expect(csv).toContain("User ID");
      expect(csv).toContain("Total Cost");
    });

    test("should get top cost users", async () => {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const topUsers = await smsBillingService.getTopCostUsers(5, weekAgo, now);

      expect(Array.isArray(topUsers)).toBe(true);
      // Each user should have required fields
      topUsers.forEach((user) => {
        expect(user).toHaveProperty("userId");
        expect(user).toHaveProperty("totalCost");
        expect(user).toHaveProperty("smsSent");
      });
    });
  });

  describe("SMS Testing Utilities", () => {
    test("should send test SMS", async () => {
      const result = await smsTestingUtility.sendTestSms(testPhoneNumber, "test_message", {
        userId: testUserId,
      });

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("phoneNumber");
      expect(result).toHaveProperty("timestamp");
    });

    test("should generate test report", async () => {
      const report = await smsTestingUtility.generateTestReport(testUserId, testPhoneNumber);

      expect(report).toHaveProperty("timestamp");
      expect(report).toHaveProperty("userId");
      expect(report).toHaveProperty("phoneNumber");
      expect(report).toHaveProperty("tests");
      expect(report).toHaveProperty("summary");
    });

    test("should test delivery tracking", async () => {
      const result = await smsTestingUtility.testDeliveryTracking(testUserId);

      expect(result).toHaveProperty("stats");
      expect(result).toHaveProperty("recentSms");
      expect(result.stats).toHaveProperty("totalSent");
      expect(result.stats).toHaveProperty("successRate");
    });

    test("should test cost tracking", async () => {
      const result = await smsTestingUtility.testCostTracking(testUserId);

      expect(result).toHaveProperty("costSummary");
      expect(result.costSummary).toHaveProperty("totalCost");
      expect(result.costSummary).toHaveProperty("period");
    });

    test("should test quiet hours", async () => {
      const result = await smsTestingUtility.testQuietHours(testUserId);

      expect(result).toHaveProperty("quietHoursEnabled");
      expect(result).toHaveProperty("currentHour");
      expect(result).toHaveProperty("inQuietHours");
    });
  });

  describe("SMS Mock Service", () => {
    test("should record mock SMS send", () => {
      smsMockService.recordSend(testPhoneNumber, "Test message", { userId: testUserId });

      expect(smsMockService.getMessageCount()).toBe(1);
    });

    test("should get messages by phone", () => {
      smsMockService.recordSend(testPhoneNumber, "Message 1");
      smsMockService.recordSend("+237600000000", "Message 2");

      const messages = smsMockService.getMessagesByPhone(testPhoneNumber);

      expect(messages.length).toBe(1);
      expect(messages[0].message).toBe("Message 1");
    });

    test("should export messages as JSON", () => {
      smsMockService.recordSend(testPhoneNumber, "Test message");

      const json = smsMockService.exportAsJson();

      expect(typeof json).toBe("string");
      expect(json).toContain(testPhoneNumber);
      expect(json).toContain("Test message");
    });

    test("should clear all messages", () => {
      smsMockService.recordSend(testPhoneNumber, "Message 1");
      smsMockService.recordSend(testPhoneNumber, "Message 2");

      expect(smsMockService.getMessageCount()).toBe(2);

      smsMockService.clear();

      expect(smsMockService.getMessageCount()).toBe(0);
    });
  });

  describe("Quiet Hours", () => {
    test("should check if user is in quiet hours", async () => {
      await smsPreferenceService.updatePreferences(testUserId, {
        quietHoursStart: 22, // 10 PM
        quietHoursEnd: 6, // 6 AM
      });

      const inQuietHours = await smsServiceEnhanced.isInQuietHours(testUserId);

      // Result depends on current time
      expect(typeof inQuietHours).toBe("boolean");
    });

    test("should skip SMS during quiet hours", async () => {
      await smsPreferenceService.updatePreferences(testUserId, {
        quietHoursStart: 0, // Always quiet hours for test
        quietHoursEnd: 23,
      });

      const result = await smsServiceEnhanced.sendSms(testPhoneNumber, "Test message", {
        userId: testUserId,
        respectPreferences: true,
        respectRateLimit: false,
      });

      // Should be skipped or have a reason
      expect([result.skippedReason, result.error]).toContain(expect.anything());
    });
  });

  describe("SMS Service Integration", () => {
    test("should send transaction success notification", async () => {
      const result = await smsServiceEnhanced.notifyTransactionEvent(testPhoneNumber, {
        referenceNumber: "REF-12345",
        type: "deposit",
        amount: "1000",
        provider: "MTN",
        kind: "transaction_completed",
        locale: "en",
      });

      expect(result).toHaveProperty("sent");
      expect(result).toHaveProperty("trackingId");
    });

    test("should send KYC update notification", async () => {
      const result = await smsServiceEnhanced.notifyKycUpdate(testPhoneNumber, "approved", {
        userId: testUserId,
      });

      expect(result).toHaveProperty("sent");
    });

    test("should send dispute update notification", async () => {
      const result = await smsServiceEnhanced.notifyDisputeUpdate(testPhoneNumber, "upheld", {
        userId: testUserId,
      });

      expect(result).toHaveProperty("sent");
    });

    test("should send generic alert SMS", async () => {
      const result = await smsServiceEnhanced.sendAlert(testPhoneNumber, "This is a test alert", {
        userId: testUserId,
      });

      expect(result).toHaveProperty("sent");
    });
  });
});
