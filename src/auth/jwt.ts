
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { RefreshTokenFamilyModel } from "../models/refreshTokenFamily";
import { redisClient } from "../config/redis";

dotenv.config();

const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || "15m";
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || "7d";
const REFRESH_BLOCKLIST_PREFIX = "refresh_blocklist:";
const refreshTokenFamilyModel = new RefreshTokenFamilyModel();

export interface JWTImpersonationClaim {
  active: true;
  readOnly: true;
  actorUserId: string;
  actorRole: string;
  targetUserId: string;
  reason: string;
  issuedAt: string;
}

interface GenerateTokenOptions {
  expiresIn?: string | number;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not defined in environment variables");
  }
  return secret;
}

function refreshTokenBlocklistKey(tokenId: string): string {
  return `${REFRESH_BLOCKLIST_PREFIX}${tokenId}`;
}

function parseDurationToSeconds(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 7 * 24 * 60 * 60;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return value;
    case "m": return value * 60;
    case "h": return value * 3600;
    case "d": return value * 86400;
    default: return 7 * 24 * 60 * 60;
  }
}

export interface JWTPayload {
  userId: string;
  email: string;
  role?: string;
  impersonation?: JWTImpersonationClaim;
  tokenVersion?: number;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  userId: string;
  familyId: string;
  tokenId: string;
  parentTokenId?: string;
  iat?: number;
  exp?: number;
}

/**
 * Generates a short-lived access token (default 15m).
 * The caller is expected to renew via the refresh token cookie.
 */
export function generateToken(
  payload: Omit<JWTPayload, "iat" | "exp">,
  options?: GenerateTokenOptions,
): string {
  const expiresIn = options?.expiresIn ?? ACCESS_TOKEN_EXPIRES_IN;
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: typeof expiresIn === 'string' ? expiresIn : expiresIn,
  } as jwt.SignOptions);
}

/**
 * Generates a refresh token with family-chain tracking.
 * On rotation (parentTokenId provided), the parent is blocklisted in Redis
 * and the old DB row is marked revoked to prevent reuse.
 */
export async function generateRefreshToken(
  userId: string,
  familyId?: string,
  parentTokenId?: string,
): Promise<string> {
  const tokenId = uuidv4();
  const famId = familyId || uuidv4();
  const payload: RefreshTokenPayload = {
    userId,
    familyId: famId,
    tokenId,
    parentTokenId,
  };
  const token = jwt.sign(payload, getJwtSecret(), {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
  });
  await refreshTokenFamilyModel.create({
    user_id: userId,
    family_id: famId,
    token,
    parent_token: parentTokenId,
  });
  return token;
}

/**
 * Verifies a JWT access token and returns the decoded payload.
 * @throws Error if token is invalid or expired
 */
export function verifyToken(token: string): JWTPayload {
  const secret = getJwtSecret();
  try {
    const decoded = jwt.verify(token, secret, { clockTolerance: 60 }) as JWTPayload;
    return decoded;
  } catch (error: unknown) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("Token has expired", { cause: error });
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid token", { cause: error });
    } else {
      throw new Error("Token verification failed", { cause: error });
    }
  }
}

/**
 * Verifies a refresh token: checks JWT signature, Redis blocklist, then DB.
 * Returns the decoded payload and DB row so the caller can blocklist the
 * used token after issuing new ones. Detects reuse and revokes the entire
 * family chain if a blocklisted or already-revoked token is presented.
 */
export async function verifyRefreshToken(token: string): Promise<{
  decoded: RefreshTokenPayload;
  dbRow: { id: string };
}> {
  const secret = getJwtSecret();
  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(token, secret) as RefreshTokenPayload;
  } catch (error: unknown) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("Refresh token has expired", { cause: error });
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid refresh token", { cause: error });
    } else {
      throw new Error("Refresh token verification failed", { cause: error });
    }
  }

  const blocklisted = await isRefreshTokenBlocklisted(decoded.tokenId);
  if (blocklisted) {
    if (decoded.familyId && decoded.userId) {
      await refreshTokenFamilyModel.revokeFamily(
        decoded.familyId,
        decoded.userId,
        "reuse_detected",
      );
    }
    throw new Error(
      "Refresh token reuse detected. All tokens in this chain are revoked. Please re-login.",
    );
  }

  const dbRow = await refreshTokenFamilyModel.findByToken(token);
  if (!dbRow || dbRow.is_revoked) {
    if (decoded.familyId && decoded.userId) {
      await refreshTokenFamilyModel.revokeFamily(
        decoded.familyId,
        decoded.userId,
        "reuse_detected",
      );
    }
    throw new Error(
      "Refresh token reuse detected. All tokens in this chain are revoked. Please re-login.",
    );
  }

  return { decoded, dbRow };
}

/**
 * Adds a refresh token ID to the Redis blocklist with a TTL matching
 * the refresh token lifetime so it cannot be reused.
 */
export async function blocklistRefreshToken(tokenId: string): Promise<void> {
  if (!redisClient.isOpen) return;
  const ttlSeconds = parseDurationToSeconds(REFRESH_TOKEN_EXPIRES_IN);
  await redisClient.set(refreshTokenBlocklistKey(tokenId), "1", {
    EX: ttlSeconds,
  });
}

/**
 * Checks whether a refresh token ID has already been consumed (blocklisted).
 */
export async function isRefreshTokenBlocklisted(tokenId: string): Promise<boolean> {
  if (!redisClient.isOpen) return false;
  const result = await redisClient.get(refreshTokenBlocklistKey(tokenId));
  return result !== null;
}

/**
 * Checks if a token is expired without throwing.
 */
export function isTokenExpired(token: string): boolean {
  try {
    verifyToken(token);
    return false;
  } catch (error) {
    return error instanceof Error && error.message === "Token has expired";
  }
}
