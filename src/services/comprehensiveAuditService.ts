/**
 * Comprehensive Audit Logging Service — Issue #167
 *
 * Provides:
 *  - Typed event categories and event types
 *  - Append-only writes to the audit_events table
 *  - Rich querying and filtering (by actor, resource, category, date range)
 *  - CSV and JSON export
 *  - Protection against modifications (immutable by DB rule)
 */

import { queryRead, queryWrite } from "../config/database";
import logger from "../utils/logger";

// ─── Event taxonomy ───────────────────────────────────────────────────────────

export enum AuditCategory {
  FINANCIAL = "financial",
  USER = "user",
  ADMIN = "admin",
  AUTH = "auth",
  SYSTEM = "system",
}

export enum AuditEventType {
  // Financial
  TRANSACTION_CREATED = "TRANSACTION_CREATED",
  TRANSACTION_COMPLETED = "TRANSACTION_COMPLETED",
  TRANSACTION_FAILED = "TRANSACTION_FAILED",
  TRANSACTION_CANCELLED = "TRANSACTION_CANCELLED",
  TRANSACTION_DISPUTED = "TRANSACTION_DISPUTED",

  // User account
  USER_REGISTERED = "USER_REGISTERED",
  USER_EMAIL_UPDATED = "USER_EMAIL_UPDATED",
  USER_PHONE_UPDATED = "USER_PHONE_UPDATED",
  USER_KYC_SUBMITTED = "USER_KYC_SUBMITTED",
  USER_KYC_APPROVED = "USER_KYC_APPROVED",
  USER_KYC_REJECTED = "USER_KYC_REJECTED",
  USER_ACCOUNT_LOCKED = "USER_ACCOUNT_LOCKED",
  USER_ACCOUNT_UNLOCKED = "USER_ACCOUNT_UNLOCKED",
  USER_ROLE_CHANGED = "USER_ROLE_CHANGED",
  USER_DELETED = "USER_DELETED",

  // Admin actions
  ADMIN_USER_VIEWED = "ADMIN_USER_VIEWED",
  ADMIN_TRANSACTION_VIEWED = "ADMIN_TRANSACTION_VIEWED",
  ADMIN_CONFIG_CHANGED = "ADMIN_CONFIG_CHANGED",
  ADMIN_REFUND_ISSUED = "ADMIN_REFUND_ISSUED",
  ADMIN_ACCOUNT_SUSPENDED = "ADMIN_ACCOUNT_SUSPENDED",
  ADMIN_KYC_OVERRIDE = "ADMIN_KYC_OVERRIDE",
  ADMIN_FEE_MODIFIED = "ADMIN_FEE_MODIFIED",

  // Authentication
  AUTH_LOGIN_SUCCESS = "AUTH_LOGIN_SUCCESS",
  AUTH_LOGIN_FAILURE = "AUTH_LOGIN_FAILURE",
  AUTH_LOGOUT = "AUTH_LOGOUT",
  AUTH_TOKEN_REFRESHED = "AUTH_TOKEN_REFRESHED",
  AUTH_TOKEN_REVOKED = "AUTH_TOKEN_REVOKED",
  AUTH_2FA_ENABLED = "AUTH_2FA_ENABLED",
  AUTH_2FA_DISABLED = "AUTH_2FA_DISABLED",
  AUTH_PASSWORD_CHANGED = "AUTH_PASSWORD_CHANGED",
  AUTH_REUSE_DETECTED = "AUTH_REUSE_DETECTED",

  // System
  SYSTEM_CONFIG_CHANGED = "SYSTEM_CONFIG_CHANGED",
  SYSTEM_PROVIDER_FAILOVER = "SYSTEM_PROVIDER_FAILOVER",
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditEvent {
  id: string;
  actorId: string | null;
  actorRole: string | null;
  actorIp: string | null;
  actorUserAgent: string | null;
  eventType: AuditEventType | string;
  category: AuditCategory | string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  success: boolean;
  errorCode: string | null;
  occurredAt: Date;
  retainUntil: Date | null;
}

export interface LogAuditEventInput {
  actorId?: string | null;
  actorRole?: string | null;
  actorIp?: string | null;
  actorUserAgent?: string | null;
  eventType: AuditEventType | string;
  category: AuditCategory | string;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  success?: boolean;
  errorCode?: string | null;
  retainUntil?: Date | null;
}

export interface AuditQueryFilter {
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  category?: AuditCategory | string;
  eventType?: AuditEventType | string;
  /** ISO 8601 string or Date */
  from?: string | Date;
  /** ISO 8601 string or Date */
  to?: string | Date;
  success?: boolean;
  /** Pagination */
  limit?: number;
  offset?: number;
}

export interface AuditQueryResult {
  events: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
}

// ─── Core write ───────────────────────────────────────────────────────────────

/**
 * Append a single audit event to the immutable audit_events table.
 * Failures are logged but never propagated — auditing must never break the
 * primary request flow.
 */
export async function logAuditEvent(
  input: LogAuditEventInput,
): Promise<string | null> {
  try {
    const result = await queryWrite(
      `INSERT INTO audit_events
        (actor_id, actor_role, actor_ip, actor_user_agent,
         event_type, category, action,
         resource_type, resource_id,
         old_values, new_values, metadata,
         success, error_code, retain_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        input.actorId ?? null,
        input.actorRole ?? null,
        input.actorIp ?? null,
        input.actorUserAgent ?? null,
        input.eventType,
        input.category,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.oldValues ? JSON.stringify(input.oldValues) : null,
        input.newValues ? JSON.stringify(input.newValues) : null,
        JSON.stringify(input.metadata ?? {}),
        input.success ?? true,
        input.errorCode ?? null,
        input.retainUntil ?? null,
      ],
    );
    return result.rows[0]?.id ?? null;
  } catch (err) {
    logger.error({ err, eventType: input.eventType }, "[AuditLog] Failed to write audit event");
    return null;
  }
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

export async function logTransactionEvent(input: {
  actorId: string;
  actorRole?: string;
  actorIp?: string;
  eventType:
    | AuditEventType.TRANSACTION_CREATED
    | AuditEventType.TRANSACTION_COMPLETED
    | AuditEventType.TRANSACTION_FAILED
    | AuditEventType.TRANSACTION_CANCELLED
    | AuditEventType.TRANSACTION_DISPUTED;
  transactionId: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  success?: boolean;
  errorCode?: string;
}): Promise<string | null> {
  return logAuditEvent({
    ...input,
    category: AuditCategory.FINANCIAL,
    action: input.eventType.replace(/_/g, " ").toLowerCase(),
    resourceType: "transaction",
    resourceId: input.transactionId,
  });
}

export async function logUserEvent(input: {
  actorId: string;
  actorRole?: string;
  actorIp?: string;
  eventType: AuditEventType | string;
  targetUserId: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  success?: boolean;
}): Promise<string | null> {
  return logAuditEvent({
    ...input,
    category: AuditCategory.USER,
    action: input.eventType.replace(/_/g, " ").toLowerCase(),
    resourceType: "user",
    resourceId: input.targetUserId,
  });
}

export async function logAdminAction(input: {
  adminId: string;
  adminRole?: string;
  actorIp?: string;
  actorUserAgent?: string;
  eventType: AuditEventType | string;
  resourceType?: string;
  resourceId?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  success?: boolean;
}): Promise<string | null> {
  return logAuditEvent({
    actorId: input.adminId,
    actorRole: input.adminRole,
    actorIp: input.actorIp,
    actorUserAgent: input.actorUserAgent,
    eventType: input.eventType,
    category: AuditCategory.ADMIN,
    action: input.eventType.replace(/_/g, " ").toLowerCase(),
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    oldValues: input.oldValues,
    newValues: input.newValues,
    metadata: input.metadata ?? {},
    success: input.success ?? true,
  });
}

export async function logAuthEvent(input: {
  actorId?: string;
  actorRole?: string;
  actorIp?: string;
  actorUserAgent?: string;
  eventType: AuditEventType | string;
  metadata?: Record<string, unknown>;
  success?: boolean;
  errorCode?: string;
}): Promise<string | null> {
  return logAuditEvent({
    ...input,
    category: AuditCategory.AUTH,
    action: input.eventType.replace(/_/g, " ").toLowerCase(),
  });
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Query audit events with optional filtering and pagination.
 * Read-only; uses query replica when available.
 */
export async function queryAuditEvents(
  filter: AuditQueryFilter = {},
): Promise<AuditQueryResult> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filter.actorId) {
    conditions.push(`actor_id = $${paramIdx++}`);
    params.push(filter.actorId);
  }
  if (filter.resourceType) {
    conditions.push(`resource_type = $${paramIdx++}`);
    params.push(filter.resourceType);
  }
  if (filter.resourceId) {
    conditions.push(`resource_id = $${paramIdx++}`);
    params.push(filter.resourceId);
  }
  if (filter.category) {
    conditions.push(`category = $${paramIdx++}`);
    params.push(filter.category);
  }
  if (filter.eventType) {
    conditions.push(`event_type = $${paramIdx++}`);
    params.push(filter.eventType);
  }
  if (filter.from) {
    conditions.push(`occurred_at >= $${paramIdx++}`);
    params.push(new Date(filter.from));
  }
  if (filter.to) {
    conditions.push(`occurred_at <= $${paramIdx++}`);
    params.push(new Date(filter.to));
  }
  if (filter.success !== undefined) {
    conditions.push(`success = $${paramIdx++}`);
    params.push(filter.success);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filter.limit ?? 100, 1000);
  const offset = filter.offset ?? 0;

  const [dataResult, countResult] = await Promise.all([
    queryRead(
      `SELECT * FROM audit_events ${where}
       ORDER BY occurred_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset],
    ),
    queryRead(
      `SELECT COUNT(*) AS total FROM audit_events ${where}`,
      params,
    ),
  ]);

  return {
    events: dataResult.rows.map(mapRow),
    total: parseInt(countResult.rows[0]?.total ?? "0", 10),
    limit,
    offset,
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

/**
 * Export audit events as a CSV string.
 */
export async function exportAuditEventsAsCsv(
  filter: AuditQueryFilter = {},
): Promise<string> {
  const { events } = await queryAuditEvents({
    ...filter,
    limit: filter.limit ?? 10_000,
  });

  const header =
    "id,occurred_at,actor_id,actor_role,actor_ip,event_type,category,action,resource_type,resource_id,success,error_code,metadata";

  const rows = events.map((e) => {
    const cols = [
      e.id,
      e.occurredAt.toISOString(),
      e.actorId ?? "",
      e.actorRole ?? "",
      e.actorIp ?? "",
      e.eventType,
      e.category,
      e.action,
      e.resourceType ?? "",
      e.resourceId ?? "",
      String(e.success),
      e.errorCode ?? "",
      JSON.stringify(e.metadata).replace(/"/g, '""'),
    ];
    return cols.map((v) => `"${v}"`).join(",");
  });

  return [header, ...rows].join("\n");
}

/**
 * Export audit events as a JSON string (pretty-printed).
 */
export async function exportAuditEventsAsJson(
  filter: AuditQueryFilter = {},
): Promise<string> {
  const result = await queryAuditEvents({
    ...filter,
    limit: filter.limit ?? 10_000,
  });
  return JSON.stringify(result, null, 2);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): AuditEvent {
  return {
    id: row.id as string,
    actorId: (row.actor_id as string | null) ?? null,
    actorRole: (row.actor_role as string | null) ?? null,
    actorIp: (row.actor_ip as string | null) ?? null,
    actorUserAgent: (row.actor_user_agent as string | null) ?? null,
    eventType: row.event_type as string,
    category: row.category as string,
    action: row.action as string,
    resourceType: (row.resource_type as string | null) ?? null,
    resourceId: (row.resource_id as string | null) ?? null,
    oldValues: row.old_values as Record<string, unknown> | null,
    newValues: row.new_values as Record<string, unknown> | null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    success: Boolean(row.success),
    errorCode: (row.error_code as string | null) ?? null,
    occurredAt: new Date(row.occurred_at as string),
    retainUntil: row.retain_until ? new Date(row.retain_until as string) : null,
  };
}
