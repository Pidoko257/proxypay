/**
 * JWT Refresh Token Rotation Service — Issue #166
 *
 * Implements:
 *  - Token rotation on every refresh (one-time-use tokens)
 *  - Reuse detection → revokes entire family on stolen token use
 *  - Device tracking: issued_at, expires_at, device_id, ip, user_agent
 *  - Multi-device session listing and targeted logout
 *  - Full logout (revoke all families for a user)
 */

import { v4 as uuidv4 } from "uuid";
import { queryRead, queryWrite, pool } from "../config/database";
import {
  generateToken,
  generateRefreshToken,
  verifyRefreshToken,
  JWTPayload,
} from "../auth/jwt";
import { getUserPermissions } from "./userService";
import logger from "../utils/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeviceInfo {
  deviceId?: string;
  deviceName?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface TokenRotationResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  deviceId: string;
}

export interface ActiveSession {
  familyId: string;
  deviceId: string | null;
  deviceName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  issuedAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Must match the REFRESH_TOKEN_EXPIRES_IN in jwt.ts ("7d") */
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Perform a token rotation:
 *  1. Verify the incoming refresh token (detects reuse automatically).
 *  2. Revoke the old token.
 *  3. Issue a new access token + a new refresh token in the same family.
 *  4. Record device metadata on the new token row.
 */
export async function rotateRefreshToken(
  incomingRefreshToken: string,
  deviceInfo: DeviceInfo = {},
  userEmail?: string,
): Promise<TokenRotationResult> {
  // Step 1: verify (also detects + handles reuse)
  const decoded = await verifyRefreshToken(incomingRefreshToken);

  // Step 2: fetch fresh user email if not provided
  let email = userEmail ?? decoded.userId;
  try {
    if (!userEmail) {
      const userResult = await queryRead(
        `SELECT phone_number FROM users WHERE id = $1`,
        [decoded.userId],
      );
      email = userResult.rows[0]?.phone_number ?? decoded.userId;
    }
  } catch {
    // non-critical — email is only used for the access token payload
  }

  // Step 3: issue new tokens
  const payload: Omit<JWTPayload, "iat" | "exp"> = {
    userId: decoded.userId,
    email,
  };
  const accessToken = generateToken(payload);
  const newRefreshToken = await generateRefreshToken(
    decoded.userId,
    decoded.familyId,
    decoded.tokenId,
  );

  // Step 4: store device metadata against the new refresh token row
  const resolvedDeviceId = deviceInfo.deviceId ?? uuidv4();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await queryWrite(
    `UPDATE refresh_token_families
     SET device_id    = $1,
         device_name  = $2,
         ip_address   = $3,
         user_agent   = $4,
         issued_at    = NOW(),
         expires_at   = $5,
         last_used_at = NOW()
     WHERE token = $6`,
    [
      resolvedDeviceId,
      deviceInfo.deviceName ?? null,
      deviceInfo.ipAddress ?? null,
      deviceInfo.userAgent ?? null,
      expiresAt,
      newRefreshToken,
    ],
  );

  // Step 5: mark the old token as used (last_used_at)
  await queryWrite(
    `UPDATE refresh_token_families SET last_used_at = NOW() WHERE token = $1`,
    [incomingRefreshToken],
  );

  logger.info(
    {
      userId: decoded.userId,
      familyId: decoded.familyId,
      deviceId: resolvedDeviceId,
    },
    "[TokenRotation] Refresh token rotated successfully",
  );

  return { accessToken, refreshToken: newRefreshToken, expiresAt, deviceId: resolvedDeviceId };
}

/**
 * List all active (non-expired, non-revoked) sessions for a user.
 * One session ≈ one refresh-token family row with a unique device.
 */
export async function listActiveSessions(userId: string): Promise<ActiveSession[]> {
  const result = await queryRead(
    `SELECT DISTINCT ON (family_id)
       family_id,
       device_id,
       device_name,
       ip_address,
       user_agent,
       issued_at,
       last_used_at,
       expires_at
     FROM refresh_token_families
     WHERE user_id    = $1
       AND is_revoked = FALSE
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY family_id, created_at DESC`,
    [userId],
  );

  return result.rows.map((row) => ({
    familyId: row.family_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    issuedAt: row.issued_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  }));
}

/**
 * Logout a specific session (family) for a user.
 * All tokens belonging to this family are soft-deleted/revoked.
 */
export async function logoutSession(
  userId: string,
  familyId: string,
): Promise<void> {
  await queryWrite(
    `UPDATE refresh_token_families
     SET is_revoked = TRUE, revoked_at = NOW()
     WHERE user_id = $1 AND family_id = $2`,
    [userId, familyId],
  );

  logger.info(
    { userId, familyId },
    "[TokenRotation] Session logged out (family revoked)",
  );
}

/**
 * Logout ALL sessions for a user (e.g. password change, security reset).
 * Every refresh token family for this user is revoked.
 */
export async function logoutAllSessions(userId: string): Promise<number> {
  const result = await queryWrite(
    `UPDATE refresh_token_families
     SET is_revoked = TRUE, revoked_at = NOW()
     WHERE user_id = $1 AND is_revoked = FALSE`,
    [userId],
  );

  const revokedCount = result.rowCount ?? 0;
  logger.info(
    { userId, revokedCount },
    "[TokenRotation] All sessions logged out",
  );

  return revokedCount;
}

/**
 * Record device metadata when issuing the *first* refresh token for a session
 * (i.e. immediately after login, before any rotation).
 */
export async function recordInitialDeviceInfo(
  refreshToken: string,
  deviceInfo: DeviceInfo,
): Promise<void> {
  const resolvedDeviceId = deviceInfo.deviceId ?? uuidv4();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await queryWrite(
    `UPDATE refresh_token_families
     SET device_id   = $1,
         device_name = $2,
         ip_address  = $3,
         user_agent  = $4,
         issued_at   = NOW(),
         expires_at  = $5
     WHERE token = $6`,
    [
      resolvedDeviceId,
      deviceInfo.deviceName ?? null,
      deviceInfo.ipAddress ?? null,
      deviceInfo.userAgent ?? null,
      expiresAt,
      refreshToken,
    ],
  );
}
