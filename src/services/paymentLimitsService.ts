import { pool } from "../config/database";
import { layeredCache } from "./layeredCache";

export type KYCTier = "unverified" | "basic" | "full";

export interface PaymentLimitConfig {
  id: string;
  organizationId: string;
  kycTier: KYCTier;
  dailyLimit: number;
  weeklyLimit: number;
  monthlyLimit: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePaymentLimitRequest {
  organizationId: string;
  kycTier: KYCTier;
  dailyLimit: number;
  weeklyLimit: number;
  monthlyLimit: number;
}

export interface UpdatePaymentLimitRequest {
  dailyLimit?: number;
  weeklyLimit?: number;
  monthlyLimit?: number;
}

export interface LimitCheckResult {
  allowed: boolean;
  kycTier: KYCTier;
  period?: "daily" | "weekly" | "monthly";
  limit?: number;
  currentUsage: number;
  remainingLimit: number;
  dailyUsage: number;
  weeklyUsage: number;
  monthlyUsage: number;
  dailyLimit: number;
  weeklyLimit: number;
  monthlyLimit: number;
  message?: string;
}

const CACHE_KEY_PREFIX = "payment_limit:";
const ORG_LIMITS_KEY_PREFIX = "payment_limits:org:";
const CACHE_TTL = 300; // 5 minutes

export class PaymentLimitsService {
  /**
   * Check whether a transaction would exceed any configured limits for the
   * given customer within their organization.
   */
  async checkTransactionLimit(
    userId: string,
    organizationId: string,
    kycTier: KYCTier,
    transactionAmount: number,
  ): Promise<LimitCheckResult> {
    const config = await this.getLimitsForOrg(organizationId, kycTier);

    if (!config) {
      return {
        allowed: true,
        kycTier,
        currentUsage: 0,
        remainingLimit: 0,
        dailyUsage: 0,
        weeklyUsage: 0,
        monthlyUsage: 0,
        dailyLimit: 0,
        weeklyLimit: 0,
        monthlyLimit: 0,
      };
    }

    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const volumeQuery = `
      SELECT
        COALESCE(SUM(CASE WHEN created_at >= $2 THEN amount::numeric ELSE 0 END), 0) AS "dailyVolume",
        COALESCE(SUM(CASE WHEN created_at >= $3 THEN amount::numeric ELSE 0 END), 0) AS "weeklyVolume",
        COALESCE(SUM(CASE WHEN created_at >= $4 THEN amount::numeric ELSE 0 END), 0) AS "monthlyVolume"
      FROM transactions
      WHERE user_id = $1
        AND status = 'completed'
        AND created_at >= $4
    `;

    const result = await pool.query(volumeQuery, [
      userId,
      dayStart,
      weekStart,
      monthStart,
    ]);

    const dailyVolume = parseFloat(result.rows[0]?.dailyVolume || "0");
    const weeklyVolume = parseFloat(result.rows[0]?.weeklyVolume || "0");
    const monthlyVolume = parseFloat(result.rows[0]?.monthlyVolume || "0");

    const dailyNewTotal = dailyVolume + transactionAmount;
    const weeklyNewTotal = weeklyVolume + transactionAmount;
    const monthlyNewTotal = monthlyVolume + transactionAmount;

    if (dailyNewTotal > config.dailyLimit) {
      return {
        allowed: false,
        kycTier,
        period: "daily",
        limit: config.dailyLimit,
        currentUsage: dailyVolume,
        remainingLimit: Math.max(0, config.dailyLimit - dailyVolume),
        dailyUsage: dailyVolume,
        weeklyUsage: weeklyVolume,
        monthlyUsage: monthlyVolume,
        dailyLimit: config.dailyLimit,
        weeklyLimit: config.weeklyLimit,
        monthlyLimit: config.monthlyLimit,
        message: `Daily limit exceeded. Current usage: ${dailyVolume} XAF, attempted: ${transactionAmount} XAF, daily limit: ${config.dailyLimit} XAF.`,
      };
    }

    if (weeklyNewTotal > config.weeklyLimit) {
      return {
        allowed: false,
        kycTier,
        period: "weekly",
        limit: config.weeklyLimit,
        currentUsage: weeklyVolume,
        remainingLimit: Math.max(0, config.weeklyLimit - weeklyVolume),
        dailyUsage: dailyVolume,
        weeklyUsage: weeklyVolume,
        monthlyUsage: monthlyVolume,
        dailyLimit: config.dailyLimit,
        weeklyLimit: config.weeklyLimit,
        monthlyLimit: config.monthlyLimit,
        message: `Weekly limit exceeded. Current usage: ${weeklyVolume} XAF, attempted: ${transactionAmount} XAF, weekly limit: ${config.weeklyLimit} XAF.`,
      };
    }

    if (monthlyNewTotal > config.monthlyLimit) {
      return {
        allowed: false,
        kycTier,
        period: "monthly",
        limit: config.monthlyLimit,
        currentUsage: monthlyVolume,
        remainingLimit: Math.max(0, config.monthlyLimit - monthlyVolume),
        dailyUsage: dailyVolume,
        weeklyUsage: weeklyVolume,
        monthlyUsage: monthlyVolume,
        dailyLimit: config.dailyLimit,
        weeklyLimit: config.weeklyLimit,
        monthlyLimit: config.monthlyLimit,
        message: `Monthly limit exceeded. Current usage: ${monthlyVolume} XAF, attempted: ${transactionAmount} XAF, monthly limit: ${config.monthlyLimit} XAF.`,
      };
    }

    return {
      allowed: true,
      kycTier,
      currentUsage: monthlyVolume,
      remainingLimit: Math.max(
        0,
        config.dailyLimit - dailyNewTotal,
        config.weeklyLimit - weeklyNewTotal,
        config.monthlyLimit - monthlyNewTotal,
      ),
      dailyUsage: dailyVolume,
      weeklyUsage: weeklyVolume,
      monthlyUsage: monthlyVolume,
      dailyLimit: config.dailyLimit,
      weeklyLimit: config.weeklyLimit,
      monthlyLimit: config.monthlyLimit,
    };
  }

  /**
   * Get all limit configurations for an organization (cached).
   */
  async getLimitsForOrg(
    organizationId: string,
    kycTier: KYCTier,
  ): Promise<PaymentLimitConfig | null> {
    const cacheKey = `${ORG_LIMITS_KEY_PREFIX}${organizationId}:${kycTier}`;
    const cached = await layeredCache.get<PaymentLimitConfig>(cacheKey);
    if (cached) {
      return cached;
    }

    const query = `
      SELECT
        id,
        organization_id AS "organizationId",
        kyc_tier AS "kycTier",
        daily_limit AS "dailyLimit",
        weekly_limit AS "weeklyLimit",
        monthly_limit AS "monthlyLimit",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM organization_payment_limits
      WHERE organization_id = $1 AND kyc_tier = $2
    `;

    const result = await pool.query(query, [organizationId, kycTier]);
    if (result.rows.length === 0) {
      return null;
    }

    const config = result.rows[0] as PaymentLimitConfig;
    await layeredCache.set(cacheKey, config, CACHE_TTL);
    return config;
  }

  /**
   * Get all limit configurations for an organization across all KYC tiers.
   */
  async getAllLimitsForOrg(
    organizationId: string,
  ): Promise<PaymentLimitConfig[]> {
    const query = `
      SELECT
        id,
        organization_id AS "organizationId",
        kyc_tier AS "kycTier",
        daily_limit AS "dailyLimit",
        weekly_limit AS "weeklyLimit",
        monthly_limit AS "monthlyLimit",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM organization_payment_limits
      WHERE organization_id = $1
      ORDER BY
        CASE kyc_tier
          WHEN 'unverified' THEN 1
          WHEN 'basic' THEN 2
          WHEN 'full' THEN 3
        END
    `;

    const result = await pool.query(query, [organizationId]);
    return result.rows;
  }

  /**
   * Create or upsert a payment limit configuration.
   */
  async createOrUpdateLimit(
    data: CreatePaymentLimitRequest,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<PaymentLimitConfig> {
    const existing = await this.getLimitsForOrg(
      data.organizationId,
      data.kycTier,
    );

    if (existing) {
      return this.updateLimit(
        existing.id,
        {
          dailyLimit: data.dailyLimit,
          weeklyLimit: data.weeklyLimit,
          monthlyLimit: data.monthlyLimit,
        },
        userId,
        ipAddress,
        userAgent,
      ) as Promise<PaymentLimitConfig>;
    }

    const query = `
      INSERT INTO organization_payment_limits (
        organization_id, kyc_tier, daily_limit, weekly_limit, monthly_limit,
        created_by, updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING
        id,
        organization_id AS "organizationId",
        kyc_tier AS "kycTier",
        daily_limit AS "dailyLimit",
        weekly_limit AS "weeklyLimit",
        monthly_limit AS "monthlyLimit",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const result = await pool.query(query, [
      data.organizationId,
      data.kycTier,
      data.dailyLimit,
      data.weeklyLimit,
      data.monthlyLimit,
      userId,
    ]);

    const config = result.rows[0] as PaymentLimitConfig;

    await this.logAuditEntry(
      config.id,
      "CREATE",
      null,
      config,
      userId,
      ipAddress,
      userAgent,
    );
    await this.invalidateOrgCache(data.organizationId, data.kycTier);

    return config;
  }

  /**
   * Partially update a payment limit configuration.
   */
  async updateLimit(
    id: string,
    data: UpdatePaymentLimitRequest,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<PaymentLimitConfig | null> {
    const oldConfig = await this.getLimitById(id);
    if (!oldConfig) {
      return null;
    }

    const updateFields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.dailyLimit !== undefined) {
      updateFields.push(`daily_limit = $${paramIndex++}`);
      values.push(data.dailyLimit);
    }
    if (data.weeklyLimit !== undefined) {
      updateFields.push(`weekly_limit = $${paramIndex++}`);
      values.push(data.weeklyLimit);
    }
    if (data.monthlyLimit !== undefined) {
      updateFields.push(`monthly_limit = $${paramIndex++}`);
      values.push(data.monthlyLimit);
    }

    if (updateFields.length === 0) {
      return oldConfig;
    }

    updateFields.push(`updated_by = $${paramIndex++}`);
    values.push(userId);
    values.push(id);

    const query = `
      UPDATE organization_payment_limits
      SET ${updateFields.join(", ")}
      WHERE id = $${paramIndex}
      RETURNING
        id,
        organization_id AS "organizationId",
        kyc_tier AS "kycTier",
        daily_limit AS "dailyLimit",
        weekly_limit AS "weeklyLimit",
        monthly_limit AS "monthlyLimit",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return null;
    }

    const newConfig = result.rows[0] as PaymentLimitConfig;

    await this.logAuditEntry(
      id,
      "UPDATE",
      oldConfig,
      newConfig,
      userId,
      ipAddress,
      userAgent,
    );
    await this.invalidateOrgCache(oldConfig.organizationId, oldConfig.kycTier);

    return newConfig;
  }

  /**
   * Delete a payment limit configuration.
   */
  async deleteLimit(
    id: string,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<boolean> {
    const oldConfig = await this.getLimitById(id);
    if (!oldConfig) {
      return false;
    }

    const query = "DELETE FROM organization_payment_limits WHERE id = $1";
    const result = await pool.query(query, [id]);

    if (result.rowCount === 0) {
      return false;
    }

    await this.logAuditEntry(
      id,
      "DELETE",
      oldConfig,
      null,
      userId,
      ipAddress,
      userAgent,
    );
    await this.invalidateOrgCache(oldConfig.organizationId, oldConfig.kycTier);

    return true;
  }

  /**
   * Get a single limit config by ID.
   */
  async getLimitById(id: string): Promise<PaymentLimitConfig | null> {
    const cacheKey = `${CACHE_KEY_PREFIX}${id}`;
    const cached = await layeredCache.get<PaymentLimitConfig>(cacheKey);
    if (cached) {
      return cached;
    }

    const query = `
      SELECT
        id,
        organization_id AS "organizationId",
        kyc_tier AS "kycTier",
        daily_limit AS "dailyLimit",
        weekly_limit AS "weeklyLimit",
        monthly_limit AS "monthlyLimit",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM organization_payment_limits
      WHERE id = $1
    `;

    const result = await pool.query(query, [id]);
    if (result.rows.length === 0) {
      return null;
    }

    const config = result.rows[0] as PaymentLimitConfig;
    await layeredCache.set(cacheKey, config, CACHE_TTL);
    return config;
  }

  /**
   * Get audit history for a limit configuration.
   */
  async getAuditHistory(limitId: string): Promise<any[]> {
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
      FROM organization_payment_limits_audit
      WHERE limit_id = $1
      ORDER BY changed_at DESC
    `;

    const result = await pool.query(query, [limitId]);
    return result.rows;
  }

  private async getLimitById(id: string): Promise<PaymentLimitConfig | null> {
    const query = `
      SELECT
        id,
        organization_id AS "organizationId",
        kyc_tier AS "kycTier",
        daily_limit AS "dailyLimit",
        weekly_limit AS "weeklyLimit",
        monthly_limit AS "monthlyLimit",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM organization_payment_limits
      WHERE id = $1
    `;

    const result = await pool.query(query, [id]);
    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0] as PaymentLimitConfig;
  }

  private async logAuditEntry(
    limitId: string,
    action: string,
    oldValues: any,
    newValues: any,
    changedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const query = `
      INSERT INTO organization_payment_limits_audit (
        limit_id, action, old_values, new_values, changed_by, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    await pool.query(query, [
      limitId,
      action,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      changedBy,
      ipAddress,
      userAgent,
    ]);
  }

  private async invalidateOrgCache(
    organizationId: string,
    kycTier: KYCTier,
  ): Promise<void> {
    const cacheKey = `${ORG_LIMITS_KEY_PREFIX}${organizationId}:${kycTier}`;
    await layeredCache.del(cacheKey);
  }
}

export const paymentLimitsService = new PaymentLimitsService();
