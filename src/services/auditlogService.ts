import { PoolClient } from "pg";
import { pool } from "../config/database";
import logger from "../utils/logger";

export interface AuditLog {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  beforeState: unknown;
  afterState: unknown;
  timestamp: Date;
}

export interface AuditEntry {
  userId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  ipAddress?: string;
  userAgent?: string;
  beforeState?: unknown;
  afterState?: unknown;
}

export async function appendAuditLog(
  client: PoolClient,
  entry: AuditEntry,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs
       (user_id, action, entity_type, entity_id, ip_address, user_agent,
        before_state, after_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [
      entry.userId,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
      entry.beforeState === undefined
        ? null
        : JSON.stringify(entry.beforeState),
      entry.afterState === undefined ? null : JSON.stringify(entry.afterState),
    ],
  );
}

export const auditService = {
  /**
   * Fetch audit logs for a specific user
   * @param userId - The user ID to fetch logs for
   * @param limit - Maximum number of logs to return (default: 100)
   * @param offset - Number of logs to skip (default: 0)
   */
  fetchAuditLogs: async (
    userId: string,
    limit: number = 100,
    offset: number = 0,
  ): Promise<AuditLog[]> => {
    try {
      const query = `
        SELECT id,
               user_id AS "userId",
               action,
               entity_type AS "entityType",
               entity_id AS "entityId",
               ip_address AS "ipAddress",
               user_agent AS "userAgent",
               before_state AS "beforeState",
               after_state AS "afterState",
               created_at AS timestamp
        FROM audit_logs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `;
      const result = await pool.query(query, [userId, limit, offset]);
      return result.rows;
    } catch (error) {
      logger.error({ error, userId }, "Failed to fetch audit logs");
      return [];
    }
  },

  /**
   * Log PII (Personally Identifiable Information) access for compliance
   * @param data - PII access details including admin ID, target ID, and metadata
   */
  logPIIAccess: async (data: {
    adminId: string;
    targetId: string;
    resource: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: any;
  }): Promise<void> => {
    try {
      const query = `
        INSERT INTO pii_access_audit_logs (admin_id, target_id, resource, ip_address, user_agent, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;
      await pool.query(query, [
        data.adminId,
        data.targetId,
        data.resource,
        data.ipAddress,
        data.userAgent,
        JSON.stringify(data.metadata || {}),
      ]);
      logger.info(
        {
          adminId: data.adminId,
          resource: data.resource,
          targetId: data.targetId,
        },
        "PII access logged",
      );
    } catch (error) {
      logger.error(
        { error, adminId: data.adminId, resource: data.resource },
        "Failed to log PII access",
      );
    }
  },
};
