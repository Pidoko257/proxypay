import { smsPreferencesModel, type SmsNotificationPreferences } from "../models/smsPreferences";
import { smsDeliveryTrackingModel } from "../models/smsDeliveryTracking";
import { queryWrite } from "../config/database";

export interface SmsPreferenceUpdateRequest {
  enabled?: boolean;
  notifyDepositSuccess?: boolean;
  notifyDepositFailure?: boolean;
  notifyWithdrawSuccess?: boolean;
  notifyWithdrawFailure?: boolean;
  notifyDisputeUpdates?: boolean;
  notifyKycUpdates?: boolean;
  maxSmsPerHour?: number;
  maxSmsPerDay?: number;
  quietHoursStart?: number;
  quietHoursEnd?: number;
}

/**
 * SMS Preference Management Service
 * 
 * Handles user SMS notification preferences, opt-in/out, and preference management
 */
export class SmsPreferenceService {
  /**
   * Get user SMS preferences
   */
  async getPreferences(userId: string): Promise<SmsNotificationPreferences> {
    let prefs = await smsPreferencesModel.findByUserId(userId);
    if (!prefs) {
      prefs = await smsPreferencesModel.createForUser(userId);
    }
    return prefs;
  }

  /**
   * Update user SMS preferences
   */
  async updatePreferences(
    userId: string,
    updates: SmsPreferenceUpdateRequest,
  ): Promise<SmsNotificationPreferences> {
    // Validate limits
    if (updates.maxSmsPerHour !== undefined && updates.maxSmsPerHour < 0) {
      throw new Error("maxSmsPerHour must be non-negative");
    }
    if (updates.maxSmsPerDay !== undefined && updates.maxSmsPerDay < 0) {
      throw new Error("maxSmsPerDay must be non-negative");
    }

    // Validate quiet hours
    if (updates.quietHoursStart !== undefined) {
      if (updates.quietHoursStart < 0 || updates.quietHoursStart > 23) {
        throw new Error("quietHoursStart must be between 0 and 23");
      }
    }
    if (updates.quietHoursEnd !== undefined) {
      if (updates.quietHoursEnd < 0 || updates.quietHoursEnd > 23) {
        throw new Error("quietHoursEnd must be between 0 and 23");
      }
    }

    // Ensure preferences exist
    let prefs = await smsPreferencesModel.findByUserId(userId);
    if (!prefs) {
      prefs = await smsPreferencesModel.createForUser(userId);
    }

    return smsPreferencesModel.updatePreferences(userId, updates);
  }

  /**
   * Opt user out of SMS notifications
   */
  async optOut(userId: string, reason?: string): Promise<SmsNotificationPreferences> {
    const prefs = await smsPreferencesModel.optOut(userId, reason);

    // Log the opt-out action
    await this.logOptOutAction(userId, "opt_out", reason, "user");

    return prefs;
  }

  /**
   * Opt user back in to SMS notifications
   */
  async optIn(userId: string): Promise<SmsNotificationPreferences> {
    const prefs = await smsPreferencesModel.optIn(userId);

    // Log the opt-in action
    await this.logOptOutAction(userId, "opt_in", undefined, "user");

    return prefs;
  }

  /**
   * Admin opt-out (for compliance or abuse prevention)
   */
  async adminOptOut(userId: string, reason: string, adminId: string): Promise<SmsNotificationPreferences> {
    const prefs = await smsPreferencesModel.optOut(userId, reason);

    // Log the admin opt-out action
    await this.logOptOutAction(userId, "opt_out", reason, "admin", { adminId });

    return prefs;
  }

  /**
   * Disable SMS notifications temporarily
   */
  async disable(userId: string): Promise<SmsNotificationPreferences> {
    return smsPreferencesModel.disable(userId);
  }

  /**
   * Enable SMS notifications
   */
  async enable(userId: string): Promise<SmsNotificationPreferences> {
    return smsPreferencesModel.enable(userId);
  }

  /**
   * Check if user can receive SMS for a specific event type
   */
  async canReceiveSmsForEvent(
    userId: string,
    eventType: "deposit_success" | "deposit_failure" | "withdraw_success" | "withdraw_failure" | "dispute" | "kyc",
  ): Promise<boolean> {
    const prefs = await this.getPreferences(userId);

    // Check if SMS is enabled and not opted out
    if (!prefs.enabled || prefs.optOut) return false;

    // Check event-specific preferences
    switch (eventType) {
      case "deposit_success":
        return prefs.notifyDepositSuccess;
      case "deposit_failure":
        return prefs.notifyDepositFailure;
      case "withdraw_success":
        return prefs.notifyWithdrawSuccess;
      case "withdraw_failure":
        return prefs.notifyWithdrawFailure;
      case "dispute":
        return prefs.notifyDisputeUpdates;
      case "kyc":
        return prefs.notifyKycUpdates;
      default:
        return false;
    }
  }

  /**
   * Get SMS delivery statistics for a user
   */
  async getDeliveryStats(userId: string): Promise<{
    totalSent: number;
    totalDelivered: number;
    totalFailed: number;
    successRate: number;
    lastSmsAt?: Date;
    nextResetAt: Date;
  }> {
    const stats = await smsDeliveryTrackingModel.getUserStats(userId);

    // Get next rate limit reset
    const now = new Date();
    const nextReset = new Date(now);
    nextReset.setUTCHours(nextReset.getUTCHours() + 1, 0, 0, 0);

    // Get last SMS timestamp
    const records = await smsDeliveryTrackingModel.findByUserId(userId, 1, 0);
    const lastSmsAt = records.length > 0 ? records[0].createdAt : undefined;

    return {
      totalSent: stats.totalSent,
      totalDelivered: stats.totalDelivered,
      totalFailed: stats.totalFailed,
      successRate: stats.successRate,
      lastSmsAt,
      nextResetAt: nextReset,
    };
  }

  /**
   * Get SMS cost summary for a user
   */
  async getCostSummary(
    userId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<{
    totalCost: number;
    successfulSmsCost: number;
    failedSmsCost: number;
    period: { start: Date; end: Date };
  }> {
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Last 30 days
    const end = endDate || new Date();

    const costs = await smsDeliveryTrackingModel.getCostSummary(userId, start, end);

    return {
      totalCost: costs.totalCost,
      successfulSmsCost: costs.successfulSmsCost,
      failedSmsCost: costs.failedSmsCost,
      period: { start, end },
    };
  }

  /**
   * Get SMS delivery history
   */
  async getDeliveryHistory(
    userId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<Array<{
    id: string;
    messageType: string;
    status: string;
    createdAt: Date;
    sentAt?: Date;
    deliveredAt?: Date;
    costUsd?: number;
  }>> {
    const records = await smsDeliveryTrackingModel.findByUserId(userId, limit, offset);
    return records.map((r) => ({
      id: r.id,
      messageType: r.messageType,
      status: r.status,
      createdAt: r.createdAt,
      sentAt: r.sentAt,
      deliveredAt: r.deliveredAt,
      costUsd: r.costUsd,
    }));
  }

  /**
   * Get list of opted-out users
   */
  async getOptedOutUsers(
    limit: number = 100,
    offset: number = 0,
  ): Promise<Array<{
    userId: string;
    optOutAt: Date;
    reason?: string;
  }>> {
    const records = await smsPreferencesModel.getOptedOutUsers(limit, offset);
    return records.map((r) => ({
      userId: r.userId,
      optOutAt: r.optOutAt || new Date(),
      reason: r.optOutReason,
    }));
  }

  /**
   * Get list of users with disabled SMS
   */
  async getDisabledUsers(
    limit: number = 100,
    offset: number = 0,
  ): Promise<Array<{
    userId: string;
    disabledAt: Date;
  }>> {
    const records = await smsPreferencesModel.getDisabledUsers(limit, offset);
    return records.map((r) => ({
      userId: r.userId,
      disabledAt: r.updatedAt,
    }));
  }

  /**
   * Reactivate user SMS notifications (after unsubscribe)
   */
  async reactivate(userId: string): Promise<SmsNotificationPreferences> {
    const prefs = await smsPreferencesModel.optIn(userId);

    // Log the reactivation
    await this.logOptOutAction(userId, "reactivate", undefined, "user");

    return prefs;
  }

  /**
   * Log SMS opt-out/opt-in actions
   */
  private async logOptOutAction(
    userId: string,
    action: "opt_out" | "opt_in" | "reactivate",
    reason?: string,
    initiatedBy: "user" | "admin" | "system" = "user",
    metadata?: Record<string, any>,
  ): Promise<void> {
    try {
      await queryWrite(
        `INSERT INTO sms_opt_out_history (user_id, action, reason, initiated_by, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, action, reason || null, initiatedBy, metadata || null],
      );
    } catch (error) {
      console.error(`Failed to log SMS opt-out action for user ${userId}:`, error);
      // Don't throw - this is not critical
    }
  }

  /**
   * Bulk enable SMS for users
   */
  async bulkEnable(userIds: string[]): Promise<number> {
    if (userIds.length === 0) return 0;

    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(",");
    const result = await queryWrite(
      `UPDATE sms_notification_preferences 
       SET enabled = true 
       WHERE user_id IN (${placeholders})`,
      userIds,
    );

    return result.rowCount || 0;
  }

  /**
   * Bulk disable SMS for users
   */
  async bulkDisable(userIds: string[], reason?: string): Promise<number> {
    if (userIds.length === 0) return 0;

    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(",");
    const result = await queryWrite(
      `UPDATE sms_notification_preferences 
       SET enabled = false 
       WHERE user_id IN (${placeholders})`,
      userIds,
    );

    return result.rowCount || 0;
  }

  /**
   * Bulk opt-out users
   */
  async bulkOptOut(userIds: string[], reason?: string): Promise<number> {
    if (userIds.length === 0) return 0;

    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(",");
    const result = await queryWrite(
      `UPDATE sms_notification_preferences 
       SET opt_out = true, opt_out_at = CURRENT_TIMESTAMP, opt_out_reason = $${userIds.length + 1}
       WHERE user_id IN (${placeholders})`,
      [...userIds, reason || null],
    );

    // Log each opt-out
    for (const userId of userIds) {
      await this.logOptOutAction(userId, "opt_out", reason, "system");
    }

    return result.rowCount || 0;
  }
}

export const smsPreferenceService = new SmsPreferenceService();
