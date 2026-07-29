import { pool } from "../config/database";
import logger from "../utils/logger";

export interface AuditLog {
  id: string;
  userId: string;
  action: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export const auditService = {
  /**
   * Fetch audit logs for a specific user
   * @param userId - The user ID to fetch logs for
   * @param limit - Maximum number of logs to return (default: 100)
   * @param offset - Number of logs to skip (default: 0)
   */
  fetchAuditLogs: async (userId: string, limit: number = 100, offset: number = 0): Promise<AuditLog[]> => {
    try {
      const query = `
        SELECT id, user_id as "userId", action, created_at as timestamp, metadata
        FROM audit_logs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `;
      const result = await pool.query(query, [userId, limit, offset]);
      return result.rows;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to fetch audit logs');
      return [];
    }
  },

  /**
   * Update an existing audit log entry
   * @param log - The audit log to update
   */
  updateAuditLog: async (log: AuditLog): Promise<void> => {
    try {
      const query = `
        UPDATE audit_logs
        SET action = $1, metadata = $2
        WHERE id = $3 AND user_id = $4
      `;
      await pool.query(query, [
        log.action,
        JSON.stringify(log.metadata || {}),
        log.id,
        log.userId,
      ]);
      logger.info({ logId: log.id, userId: log.userId }, 'Audit log updated');
    } catch (error) {
      logger.error({ error, logId: log.id }, 'Failed to update audit log');
      throw new Error("Failed to update audit log");
    }
  },

  /**
   * Log administrative configuration change into audit_log table with before/after values.
   */
  logConfigChange: async (data: {
    userId?: string;
    action: string;
    resource: string;
    resourceId?: string;
    oldValue?: any;
    newValue?: any;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> => {
    try {
      const query = `
        INSERT INTO audit_log (user_id, action, resource, resource_id, old_value, new_value, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `;
      await pool.query(query, [
        data.userId || null,
        data.action,
        data.resource,
        data.resourceId || null,
        data.oldValue ? JSON.stringify(data.oldValue) : null,
        data.newValue ? JSON.stringify(data.newValue) : null,
        data.ipAddress || null,
        data.userAgent || null,
      ]);
      logger.info({ userId: data.userId, resource: data.resource, action: data.action }, 'Config change logged');
    } catch (error) {
      logger.error({ error, userId: data.userId, resource: data.resource }, 'Failed to log config change');
    }
  },

  /**
   * Fetch configuration audit logs with optional filters.
   */
  fetchConfigAuditLogs: async (filters: {
    resource?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> => {
    try {
      const conditions: string[] = [];
      const values: any[] = [];

      if (filters.resource) {
        values.push(filters.resource);
        conditions.push(`resource = $${values.length}`);
      }
      if (filters.userId) {
        values.push(filters.userId);
        conditions.push(`user_id = $${values.length}`);
      }

      const limit = filters.limit || 100;
      const offset = filters.offset || 0;

      values.push(limit, offset);
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const query = `
        SELECT id, user_id as "userId", action, resource, resource_id as "resourceId", old_value as "oldValue", new_value as "newValue", ip_address as "ipAddress", user_agent as "userAgent", created_at as timestamp
        FROM audit_log
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}
      `;
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch config audit logs');
      return [];
    }
  },

  /**
   * Export audit logs for regulatory compliance audits in CSV or JSON format.
   */
  exportAuditLogs: async (format: "csv" | "json" = "json", filters?: { resource?: string; userId?: string }): Promise<string> => {
    try {
      const logs = await auditService.fetchConfigAuditLogs({ ...filters, limit: 5000, offset: 0 });
      if (format === "json") {
        return JSON.stringify(logs, null, 2);
      }

      const headers = ["id", "userId", "action", "resource", "resourceId", "oldValue", "newValue", "ipAddress", "timestamp"];
      const rows = logs.map((log) => [
        log.id,
        log.userId || "",
        log.action,
        log.resource,
        log.resourceId || "",
        JSON.stringify(log.oldValue || {}).replace(/"/g, '""'),
        JSON.stringify(log.newValue || {}).replace(/"/g, '""'),
        log.ipAddress || "",
        log.timestamp,
      ].map((val) => `"${val}"`).join(","));

      return [headers.join(","), ...rows].join("\n");
    } catch (error) {
      logger.error({ error }, 'Failed to export audit logs');
      throw new Error("Failed to export audit logs");
    }
  },
};

