import { Pool } from "pg";
import { queryRead, queryWrite } from "../config/database";
import { securityAnomalyService } from "../services/securityAnomalyService";

interface BulkOperationRecord {
  userId: string;
  ipAddress: string;
  createdAt: Date;
}

const BULK_OPERATION_THRESHOLD = 10;
const UNUSUAL_HOURS_START = 2;
const UNUSUAL_HOURS_END = 5;

export async function runAnomalyDetectionJob(): Promise<void> {
  const now = new Date();
  const currentHour = now.getHours();
  const isUnusualHours = currentHour >= UNUSUAL_HOURS_START && currentHour <= UNUSUAL_HOURS_END;

  if (isUnusualHours) {
    const result = await queryRead<BulkOperationRecord>(
      `SELECT user_id as "userId", ip_address as "ipAddress", created_at as "createdAt"
       FROM transactions 
       WHERE created_at > NOW() - INTERVAL '1 hour'
       GROUP BY user_id, ip_address, created_at
       HAVING COUNT(*) >= $1`,
      [BULK_OPERATION_THRESHOLD]
    );

    for (const record of result.rows) {
      const hourCount = await queryRead<{ count: number }>(
        `SELECT COUNT(*) as count FROM transactions 
         WHERE user_id = $1 AND date_trunc('hour', created_at) = date_trunc('hour', NOW())`,
        [record.userId]
      );

      if (hourCount.rows[0]?.count >= BULK_OPERATION_THRESHOLD) {
        await securityAnomalyService.createSecurityEvent({
          userId: record.userId,
          eventType: "bulk_operation_unusual_hours",
          severity: "medium",
          ipAddress: record.ipAddress,
          metadata: {
            operationCount: hourCount.rows[0].count,
            hour: currentHour,
          },
        });
      }
    }
  }

  const userResult = await queryRead(
    `SELECT id FROM users WHERE status = 'active'`
  );

  for (const user of userResult.rows) {
    await securityAnomalyService.buildBaselineFromHistory(user.id);
  }
}