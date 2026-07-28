import { PoolClient } from "pg";
import { pool } from "../config/database";
import { appendAuditLog, AuditEntry } from "./auditlogService";

export interface AuditedOperation<T> {
  value: T;
  audit: Omit<AuditEntry, "userId" | "ipAddress" | "userAgent">;
}

export async function withAuditTransaction<T>(
  context: Pick<AuditEntry, "userId" | "ipAddress" | "userAgent">,
  operation: (client: PoolClient) => Promise<AuditedOperation<T>>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);

    await appendAuditLog(client, {
      ...result.audit,
      userId: context.userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    await client.query("COMMIT");
    return result.value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
