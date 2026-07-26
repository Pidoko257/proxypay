import { pool } from "../config/database";
import { layeredCache } from "./layeredCache";

export interface OrganizationSettings {
  id: string;
  organizationId: string;
  defaultCurrency: string;
  paymentNotificationEnabled: boolean;
  paymentNotificationUrl: string | null;
  ipAllowlist: string[];
  customFeeTierOverride: Record<string, any>;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateOrganizationSettingsRequest {
  defaultCurrency?: string;
  paymentNotificationEnabled?: boolean;
  paymentNotificationUrl?: string | null;
  ipAllowlist?: string[];
  customFeeTierOverride?: Record<string, any>;
}

const CACHE_KEY_PREFIX = "org_settings:";
const CACHE_TTL = 300; // 5 minutes

export class OrganizationSettingsService {
  /**
   * Get organization settings (cached).
   */
  async getSettings(
    organizationId: string,
  ): Promise<OrganizationSettings | null> {
    const cacheKey = `${CACHE_KEY_PREFIX}${organizationId}`;
    const cached = await layeredCache.get<OrganizationSettings>(cacheKey);
    if (cached) {
      return cached;
    }

    const query = `
      SELECT
        id,
        organization_id AS "organizationId",
        default_currency AS "defaultCurrency",
        payment_notification_enabled AS "paymentNotificationEnabled",
        payment_notification_url AS "paymentNotificationUrl",
        ip_allowlist AS "ipAllowlist",
        custom_fee_tier_override AS "customFeeTierOverride",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM organization_settings
      WHERE organization_id = $1
    `;

    const result = await pool.query(query, [organizationId]);
    if (result.rows.length === 0) {
      return null;
    }

    const settings = this.mapRow(result.rows[0]);
    await layeredCache.set(cacheKey, settings, CACHE_TTL);
    return settings;
  }

  /**
   * Get or create organization settings, ensuring a row always exists.
   */
  async getOrCreateSettings(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationSettings> {
    const existing = await this.getSettings(organizationId);
    if (existing) {
      return existing;
    }

    const query = `
      INSERT INTO organization_settings (
        organization_id, created_by, updated_by
      ) VALUES ($1, $2, $2)
      RETURNING
        id,
        organization_id AS "organizationId",
        default_currency AS "defaultCurrency",
        payment_notification_enabled AS "paymentNotificationEnabled",
        payment_notification_url AS "paymentNotificationUrl",
        ip_allowlist AS "ipAllowlist",
        custom_fee_tier_override AS "customFeeTierOverride",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const result = await pool.query(query, [organizationId, userId]);
    const settings = this.mapRow(result.rows[0]);
    await layeredCache.set(
      `${CACHE_KEY_PREFIX}${organizationId}`,
      settings,
      CACHE_TTL,
    );

    await this.logAuditEntry(organizationId, "CREATE", null, settings, userId);

    return settings;
  }

  /**
   * Partially update organization settings.
   */
  async updateSettings(
    organizationId: string,
    data: UpdateOrganizationSettingsRequest,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<OrganizationSettings | null> {
    const oldSettings = await this.getSettings(organizationId);
    if (!oldSettings) {
      return null;
    }

    const updateFields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.defaultCurrency !== undefined) {
      updateFields.push(`default_currency = $${paramIndex++}`);
      values.push(data.defaultCurrency);
    }
    if (data.paymentNotificationEnabled !== undefined) {
      updateFields.push(`payment_notification_enabled = $${paramIndex++}`);
      values.push(data.paymentNotificationEnabled);
    }
    if (data.paymentNotificationUrl !== undefined) {
      updateFields.push(`payment_notification_url = $${paramIndex++}`);
      values.push(data.paymentNotificationUrl);
    }
    if (data.ipAllowlist !== undefined) {
      updateFields.push(`ip_allowlist = $${paramIndex++}`);
      values.push(data.ipAllowlist);
    }
    if (data.customFeeTierOverride !== undefined) {
      updateFields.push(`custom_fee_tier_override = $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(data.customFeeTierOverride));
    }

    if (updateFields.length === 0) {
      return oldSettings;
    }

    updateFields.push(`updated_by = $${paramIndex++}`);
    values.push(userId);
    values.push(organizationId);

    const query = `
      UPDATE organization_settings
      SET ${updateFields.join(", ")}
      WHERE organization_id = $${paramIndex}
      RETURNING
        id,
        organization_id AS "organizationId",
        default_currency AS "defaultCurrency",
        payment_notification_enabled AS "paymentNotificationEnabled",
        payment_notification_url AS "paymentNotificationUrl",
        ip_allowlist AS "ipAllowlist",
        custom_fee_tier_override AS "customFeeTierOverride",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return null;
    }

    const newSettings = this.mapRow(result.rows[0]);

    await this.invalidateCache(organizationId);
    await this.logAuditEntry(
      organizationId,
      "UPDATE",
      oldSettings,
      newSettings,
      userId,
      ipAddress,
      userAgent,
    );

    return newSettings;
  }

  /**
   * Get audit history for an organization's settings.
   */
  async getAuditHistory(organizationId: string): Promise<any[]> {
    const query = `
      SELECT
        id,
        action,
        old_values AS "oldValues",
        new_values AS "newValues",
        changed_by AS "changedBy",
        ip_address AS "ipAddress",
        user_agent AS "userAgent",
        changed_at AS "changedAt"
      FROM organization_settings_audit
      WHERE organization_id = $1
      ORDER BY changed_at DESC
    `;

    const result = await pool.query(query, [organizationId]);
    return result.rows;
  }

  private async logAuditEntry(
    organizationId: string,
    action: string,
    oldValues: any,
    newValues: any,
    changedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const query = `
      INSERT INTO organization_settings_audit (
        organization_id, action, old_values, new_values, changed_by, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    await pool.query(query, [
      organizationId,
      action,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      changedBy,
      ipAddress,
      userAgent,
    ]);
  }

  private async invalidateCache(organizationId: string): Promise<void> {
    await layeredCache.del(`${CACHE_KEY_PREFIX}${organizationId}`);
  }

  private mapRow(row: any): OrganizationSettings {
    return {
      id: row.id,
      organizationId: row.organizationId,
      defaultCurrency: row.defaultCurrency,
      paymentNotificationEnabled: row.paymentNotificationEnabled,
      paymentNotificationUrl: row.paymentNotificationUrl,
      ipAllowlist: row.ipAllowlist || [],
      customFeeTierOverride: row.customFeeTierOverride || {},
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export const organizationSettingsService = new OrganizationSettingsService();
