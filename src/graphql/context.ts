import type { Request } from "express";
import { GraphQLError } from "graphql";
import { TransactionModel } from "../models/transaction";
import { DisputeService } from "../services/dispute";
import { lockManager, LockKeys } from "../utils/lock";
import { addTransactionJob, getJobProgress } from "../queue";
import { getBulkImportJob } from "../routes/bulk";
import type { TypedPubSub } from "./subscriptions";
import { getRedisPubSub } from "./redisPubSub";
import { createDataLoaders, type GraphQLDataLoaders } from "./dataLoaders";
import { verifyToken } from "../auth/jwt";

// ---------------------------------------------------------------------------
// Singleton instances (shared across requests)
// ---------------------------------------------------------------------------

const transactionModel = new TransactionModel();
const disputeService = new DisputeService();
const pubsub = getRedisPubSub();

// ---------------------------------------------------------------------------
// Auth types
// ---------------------------------------------------------------------------

export type UserRole =
  | "admin"
  | "super-admin"
  | "compliance_officer"
  | "support"
  | "api-client"
  | "user";

export interface GraphQLAuth {
  authenticated: boolean;
  subject: string | null;
  role: UserRole;
  /** True when authenticated via JWT (richer claims available) */
  isJwt: boolean;
  userId?: string;
}

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

export interface GraphQLContext {
  auth: GraphQLAuth;
  transactionModel: TransactionModel;
  disputeService: DisputeService;
  lockManager: typeof lockManager;
  LockKeys: typeof LockKeys;
  addTransactionJob: typeof addTransactionJob;
  getJobProgress: typeof getJobProgress;
  getBulkImportJob: typeof getBulkImportJob;
  pubsub: TypedPubSub;
  loaders: GraphQLDataLoaders;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Throw a GraphQL UNAUTHENTICATED error.
 * Use at the top of any resolver that requires authentication.
 */
export function requireAuth(auth: GraphQLAuth): void {
  if (!auth.authenticated) {
    throw new GraphQLError("Authentication required", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
}

/**
 * Throw a FORBIDDEN error if the caller's role is not in the allowed set.
 */
export function requireRole(
  auth: GraphQLAuth,
  ...roles: UserRole[]
): void {
  requireAuth(auth);
  if (!roles.includes(auth.role)) {
    throw new GraphQLError(
      `Insufficient permissions. Required role: ${roles.join(" or ")}`,
      { extensions: { code: "FORBIDDEN" } },
    );
  }
}

// ---------------------------------------------------------------------------
// Request auth resolution
// ---------------------------------------------------------------------------

function resolveAuth(req: Request | undefined): GraphQLAuth {
  const unauthenticated: GraphQLAuth = {
    authenticated: false,
    subject: null,
    role: "user",
    isJwt: false,
  };

  // ── JWT auth (preferred for richer user context) ──────────────────────────
  const authHeader = req?.headers?.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    try {
      const claims = verifyToken(token);
      return {
        authenticated: true,
        subject: claims.userId,
        role: (claims.role as UserRole) ?? "user",
        isJwt: true,
        userId: claims.userId,
      };
    } catch {
      // Fall through to API key check
    }
  }

  // ── API key auth ──────────────────────────────────────────────────────────
  const expected = process.env.GRAPHQL_API_KEY?.trim();

  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      throw new GraphQLError(
        "GRAPHQL_API_KEY must be set in production",
        { extensions: { code: "UNAUTHENTICATED" } },
      );
    }
    // Dev: allow unauthenticated access
    return unauthenticated;
  }

  const header = req?.headers?.["x-api-key"];
  const raw = Array.isArray(header) ? header[0] : header;
  const provided = raw;

  if (!provided || provided !== expected) {
    throw new GraphQLError("Invalid or missing API key", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  return {
    authenticated: true,
    subject:
      process.env.GRAPHQL_CLIENT_SUBJECT?.trim() ?? "api-client",
    role: "api-client",
    isJwt: false,
  };
}

// ---------------------------------------------------------------------------
// Context factory
// ---------------------------------------------------------------------------

export function buildGraphqlContext(req: Request): GraphQLContext {
  const auth = resolveAuth(req);
  return {
    auth,
    transactionModel,
    disputeService,
    lockManager,
    LockKeys,
    addTransactionJob,
    getJobProgress,
    getBulkImportJob,
    pubsub,
    // Fresh DataLoader instances per request (request-scoped cache)
    loaders: createDataLoaders(),
  };
}
