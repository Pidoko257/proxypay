import type { Request } from "express";
import { GraphQLError } from "graphql";
import { pool, queryRead } from "../config/database";
import { TransactionModel } from "../models/transaction";
import { DisputeService } from "../services/dispute";
import { lockManager, LockKeys } from "../utils/lock";
import { addTransactionJob, getJobProgress } from "../queue";
import { getBulkImportJob } from "../routes/bulk";
import type { TypedPubSub } from "./subscriptions";
import { getRedisPubSub } from "./redisPubSub";

const transactionModel = new TransactionModel();
const disputeService = new DisputeService();
// Use Redis-backed pubsub so events fan out across all server instances
const pubsub = getRedisPubSub();

export interface GraphQLAuth {
  authenticated: boolean;
  subject: string | null;
}

/**
 * User role information extracted from the database
 */
export interface UserRoleInfo {
  userId: string;
  roleId: string;
  roleName: string;
  permissions: string[];
}

export interface GraphQLContext {
  auth: GraphQLAuth;
  userRole?: string; // User's role (admin, compliance, support, user, etc.)
  userRoleInfo?: UserRoleInfo; // Full role information with permissions
  userId?: string; // Authenticated user ID
  transactionModel: TransactionModel;
  disputeService: DisputeService;
  lockManager: typeof lockManager;
  LockKeys: typeof LockKeys;
  addTransactionJob: typeof addTransactionJob;
  getJobProgress: typeof getJobProgress;
  getBulkImportJob: typeof getBulkImportJob;
  pubsub: TypedPubSub;
}

function resolveAuth(req: Request): GraphQLAuth {
  const expected = process.env.GRAPHQL_API_KEY?.trim();
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      throw new GraphQLError(
        "GRAPHQL_API_KEY must be set when NODE_ENV is production",
        { extensions: { code: "UNAUTHENTICATED" } },
      );
    }
    return { authenticated: false, subject: null };
  }

  const header = req.headers["x-api-key"];
  const raw = Array.isArray(header) ? header[0] : header;
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7).trim()
    : undefined;
  const provided = raw || bearer;
  if (!provided || provided !== expected) {
    throw new GraphQLError("Invalid or missing API key", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return {
    authenticated: true,
    subject: process.env.GRAPHQL_CLIENT_SUBJECT?.trim() || "api-client",
  };
}

/**
 * Fetch user role information from database
 * Returns role name and permissions for the user
 */
async function getUserRoleInfo(userId: string): Promise<UserRoleInfo | null> {
  try {
    const result = await queryRead(
      `SELECT 
        u.id AS "userId",
        r.id AS "roleId",
        r.name AS "roleName",
        COALESCE(
          array_agg(p.name) FILTER (WHERE p.name IS NOT NULL),
          ARRAY[]::text[]
        ) AS permissions
      FROM users u
      JOIN roles r ON u.role_id = r.id
      LEFT JOIN role_permissions rp ON r.id = rp.role_id
      LEFT JOIN permissions p ON rp.permission_id = p.id
      WHERE u.id = $1
      GROUP BY u.id, r.id, r.name`,
      [userId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      userId: row.userId,
      roleId: row.roleId,
      roleName: row.roleName,
      permissions: row.permissions || [],
    };
  } catch (error) {
    console.warn(`Failed to fetch role info for user ${userId}:`, error);
    return null;
  }
}

/**
 * Extract user ID from request
 * Supports JWT tokens and API key authentication
 */
function extractUserId(req: Request): string | undefined {
  // Check if jwtUser is attached (from JWT authentication)
  if ((req as any).jwtUser?.userId) {
    return (req as any).jwtUser.userId;
  }

  // Check for user object (from API key or other auth)
  if ((req as any).user?.id) {
    return (req as any).user.id;
  }

  return undefined;
}

export async function buildGraphqlContext(req: Request): Promise<GraphQLContext> {
  const auth = resolveAuth(req);
  const userId = extractUserId(req);
  
  // Fetch user role information if authenticated
  let userRoleInfo: UserRoleInfo | null = null;
  let userRole: string | undefined;
  
  if (auth.authenticated && userId) {
    userRoleInfo = await getUserRoleInfo(userId);
    userRole = userRoleInfo?.roleName;
  }

  return {
    auth,
    userId,
    userRole,
    userRoleInfo: userRoleInfo || undefined,
    transactionModel,
    disputeService,
    lockManager,
    LockKeys,
    addTransactionJob,
    getJobProgress,
    getBulkImportJob,
    pubsub,
  };
}
