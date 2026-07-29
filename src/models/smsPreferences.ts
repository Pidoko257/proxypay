import { queryRead, queryWrite } from "../config/database";

export interface SmsNotificationPreferences {
  id: string;
  userId: string;
  enabled: boolean;
  optOut: boolean;
  optOutAt?: Date;
  optOutReason?: string;
  notifyDepositSuccess: boolean;
  notifyDepositFailure: boolean;
  notifyWithdrawSuccess: boolean;
  notifyWithdrawFailure: boolean;
  notifyDisputeUpdates: boolean;
  notifyKycUpdates: boolean;
  maxSmsPerHour: number;
  maxSmsPerDay: number;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  createdAt: Date;
  updatedAt: Date;
}

export class SmsPreferencesModel {
  /**
   * Find SMS preferences by user ID
   */
  async findByUserId(userId: string): Promise<SmsNotificationPreferences | null> {
    const result = await queryRead(
      "SELECT * FROM sms_notification_preferences WHERE user_id = $1",
      [userId],
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  /**
   * Create default SMS preferences for a new user
   */
  async createForUser(userId: string): Promise<SmsNotificationPreferences> {
    const result = await queryWrite(
      `INSERT INTO sms_notification_preferences 
       (user_id, enabled, opt_out, notify_deposit_success, notify_deposit_failure, 
        notify_withdraw_success, notify_withdraw_failure, notify_dispute_updates, 
        notify_kyc_updates, max_sms_per_hour, max_sms_per_day)
       VALUES ($1, true, false, true, true, true, true, true, true, 5, 20)
       RETURNING *`,
      [userId],
    );
    return this.mapRow(result.rows[0]);
  }

  /**
   * Update user SMS preferences
   */
  async updatePreferences(
    userId: string,
    updates: Partial<SmsNotificationPreferences>,
  ): Promise<SmsNotificationPreferences> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (updates.enabled !== undefined) {
      fields.push(`enabled = $${paramIdx++}`);
      values.push(updates.enabled);
    }
    if (updates.notifyDepositSuccess !== undefined) {
      fields.push(`notify_deposit_success = $${paramIdx++}`);
      values.push(updates.notifyDepositSuccess);
    }
    if (updates.notifyDepositFailure !== undefined) {
      fields.push(`notify_deposit_failure = $${paramIdx++}`);
      values.push(updates.notifyDepositFailure);
    }
    if (updates.notifyWithdrawSuccess !== undefined) {
      fields.push(`notify_withdraw_success = $${paramIdx++}`);
      values.push(updates.notifyWithdrawSuccess);
    }
    if (updates.notifyWithdrawFailure !== undefined) {
      fields.push(`notify_withdraw_failure = $${paramIdx++}`);
      values.push(updates.notifyWithdrawFailure);
    }
    if (updates.notifyDisputeUpdates !== undefined) {
      fields.push(`notify_dispute_updates = $${paramIdx++}`);
      values.push(updates.notifyDisputeUpdates);
    }
    if (updates.notifyKycUpdates !== undefined) {
      fields.push(`notify_kyc_updates = $${paramIdx++}`);
      values.push(updates.notifyKycUpdates);
    }
    if (updates.maxSmsPerHour !== undefined) {
      fields.push(`max_sms_per_hour = $${paramIdx++}`);
      values.push(updates.maxSmsPerHour);
    }
    if (updates.maxSmsPerDay !== undefined) {
      fields.push(`max_sms_per_day = $${paramIdx++}`);
      values.push(updates.maxSmsPerDay);
    }
    if (updates.quietHoursStart !== undefined) {
      fields.push(`quiet_hours_start = $${paramIdx++}`);
      values.push(updates.quietHoursStart);
    }
    if (updates.quietHoursEnd !== undefined) {
      fields.push(`quiet_hours_end = $${paramIdx++}`);
      values.push(updates.quietHoursEnd);
    }

    if (fields.length === 0) {
      // No updates - return current preferences
      const existing = await this.findByUserId(userId);
      if (!existing) {
        throw new Error(`SMS preferences not found for user ${userId}`);
      }
      return existing;
    }

    values.push(userId);
    const query = `UPDATE sms_notification_preferences 
                   SET ${fields.join(", ")} 
                   WHERE user_id = $${paramIdx++}
                   RETURNING *`;

    const result = await queryWrite(query, values);
    return this.mapRow(result.rows[0]);
  }

  /**
   * Opt user out of SMS notifications
   */
  async optOut(
    userId: string,
    reason?: string,
  ): Promise<SmsNotificationPreferences> {
    const result = await queryWrite(
      `UPDATE sms_notification_preferences 
       SET opt_out = true, opt_out_at = CURRENT_TIMESTAMP, opt_out_reason = $2
       WHERE user_id = $1
       RETURNING *`,
      [userId, reason || null],
    );
    return this.mapRow(result.rows[0]);
  }

  /**
   * Opt user back in to SMS notifications
   */
  async optIn(userId: string): Promise<SmsNotificationPreferences> {
    const result = await queryWrite(
      `UPDATE sms_notification_preferences 
       SET opt_out = false, opt_out_at = NULL, opt_out_reason = NULL
       WHERE user_id = $1
       RETURNING *`,
      [userId],
    );
    return this.mapRow(result.rows[0]);
  }

  /**
   * Disable SMS notifications (but don't mark as opted out)
   */
  async disable(userId: string): Promise<SmsNotificationPreferences> {
    const result = await queryWrite(
      `UPDATE sms_notification_preferences 
       SET enabled = false
       WHERE user_id = $1
       RETURNING *`,
      [userId],
    );
    return this.mapRow(result.rows[0]);
  }

  /**
   * Enable SMS notifications
   */
  async enable(userId: string): Promise<SmsNotificationPreferences> {
    const result = await queryWrite(
      `UPDATE sms_notification_preferences 
       SET enabled = true
       WHERE user_id = $1
       RETURNING *`,
      [userId],
    );
    return this.mapRow(result.rows[0]);
  }

  /**
   * Check if user can receive SMS notifications
   */
  async canReceiveSms(userId: string): Promise<boolean> {
    const prefs = await this.findByUserId(userId);
    if (!prefs) return true; // Default to true if no preferences set yet
    return prefs.enabled && !prefs.optOut;
  }

  /**
   * Get users opted out of SMS
   */
  async getOptedOutUsers(limit: number = 100, offset: number = 0): Promise<SmsNotificationPreferences[]> {
    const result = await queryRead(
      `SELECT * FROM sms_notification_preferences 
       WHERE opt_out = true 
       ORDER BY opt_out_at DESC 
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * Get users with disabled SMS notifications
   */
  async getDisabledUsers(limit: number = 100, offset: number = 0): Promise<SmsNotificationPreferences[]> {
    const result = await queryRead(
      `SELECT * FROM sms_notification_preferences 
       WHERE enabled = false
       ORDER BY updated_at DESC 
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: any): SmsNotificationPreferences {
    return {
      id: row.id,
      userId: row.user_id,
      enabled: row.enabled,
      optOut: row.opt_out,
      optOutAt: row.opt_out_at ? new Date(row.opt_out_at) : undefined,
      optOutReason: row.opt_out_reason,
      notifyDepositSuccess: row.notify_deposit_success,
      notifyDepositFailure: row.notify_deposit_failure,
      notifyWithdrawSuccess: row.notify_withdraw_success,
      notifyWithdrawFailure: row.notify_withdraw_failure,
      notifyDisputeUpdates: row.notify_dispute_updates,
      notifyKycUpdates: row.notify_kyc_updates,
      maxSmsPerHour: row.max_sms_per_hour,
      maxSmsPerDay: row.max_sms_per_day,
      quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export const smsPreferencesModel = new SmsPreferencesModel();
