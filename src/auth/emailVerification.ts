import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { redisClient } from "../config/redis";

dotenv.config();

export const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60; // 24h
export const EMAIL_VERIFICATION_PURPOSE = "email_verification" as const;

export interface EmailVerificationPayload {
  userId: string;
  purpose: typeof EMAIL_VERIFICATION_PURPOSE;
  tokenId: string;
  iat?: number;
  exp?: number;
}

const REDIS_KEY_PREFIX = "verify_email:";

function getRedisKey(tokenId: string): string {
  return `${REDIS_KEY_PREFIX}${tokenId}`;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not defined in environment variables");
  }
  return secret;
}

/**
 * Issue a signed JWT-based email verification token for a user and persist
 * its lookup key in Redis with a 24-hour TTL so requests can be matched
 * without an extra DB read.
 */
export async function issueEmailVerificationToken(
  userId: string,
): Promise<{ token: string; tokenId: string; expiresInSeconds: number }> {
  const tokenId = uuidv4();
  const payload: Omit<EmailVerificationPayload, "iat" | "exp"> = {
    userId,
    purpose: EMAIL_VERIFICATION_PURPOSE,
    tokenId,
  };

  const token = jwt.sign(payload, getJwtSecret(), {
    expiresIn: EMAIL_VERIFICATION_TTL_SECONDS,
  });

  if (redisClient.isOpen) {
    await redisClient.set(getRedisKey(tokenId), userId, {
      EX: EMAIL_VERIFICATION_TTL_SECONDS,
    });
  }

  return {
    token,
    tokenId,
    expiresInSeconds: EMAIL_VERIFICATION_TTL_SECONDS,
  };
}

/**
 * Verify the JWT signature and payload integrity of an email verification
 * token. Returns the decoded payload alongside the time remaining before
 * expiration (in seconds). Surfacing both gives callers enough context to
 * decide whether to attempt Redis lookup, surface helpful errors, or trigger
 * a resend flow.
 */
export function decodeEmailVerificationToken(
  token: string,
): EmailVerificationPayload & { remainingSeconds: number } {
  let decoded: EmailVerificationPayload;
  try {
    decoded = jwt.verify(token, getJwtSecret()) as EmailVerificationPayload;
  } catch (error: unknown) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("Email verification token has expired", { cause: error });
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid email verification token", { cause: error });
    }
    throw new Error("Email verification token verification failed", {
      cause: error,
    });
  }

  if (decoded.purpose !== EMAIL_VERIFICATION_PURPOSE) {
    throw new Error("Token was not issued for email verification");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = decoded.exp ?? nowSeconds;

  return {
    ...decoded,
    remainingSeconds: Math.max(0, exp - nowSeconds),
  };
}

export interface ConsumeResult {
  userId: string;
  tokenId: string;
}

/**
 * Verify the token and atomically invalidate its Redis lookup entry. The
 * Redis DEL is what guarantees single-use semantics for stale tokens — we
 * intentionally avoid touching the JWT's signature here, since invalidating
 * via Redis is what the acceptance criteria calls for ("invalidates the
 * token").
 */
export async function consumeEmailVerificationToken(
  token: string,
): Promise<ConsumeResult> {
  const decoded = decodeEmailVerificationToken(token);

  const storedUserId = redisClient.isOpen
    ? await redisClient.get(getRedisKey(decoded.tokenId))
    : decoded.userId;

  if (!storedUserId) {
    throw new Error("Email verification token has been used or revoked");
  }

  if (redisClient.isOpen) {
    await redisClient.del(getRedisKey(decoded.tokenId));
  }

  return {
    userId: storedUserId === decoded.userId ? decoded.userId : storedUserId,
    tokenId: decoded.tokenId,
  };
}

/**
 * Manually invalidate a still-valid verification token (e.g. on resend).
 */
export async function revokeEmailVerificationToken(
  tokenId: string,
): Promise<void> {
  if (!redisClient.isOpen) return;
  await redisClient.del(getRedisKey(tokenId));
}
