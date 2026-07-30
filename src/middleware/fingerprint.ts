import { Request, Response, NextFunction } from "express";
import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import { createHash } from "crypto";
import { getCurrentRequestIp } from "../services/loginAnomaly";

declare module "express-serve-static-core" {
  interface Request {
    isNewDevice?: boolean;
  }
}

/** Number of new-device fingerprints within the window before step-up auth is required. */
const MISMATCH_STEP_UP_THRESHOLD = 3;
const MISMATCH_WINDOW_SECONDS = 24 * 60 * 60;

export function hashString(value: string | null | undefined): string {
  const v = value ?? "";
  return createHash("sha256").update(v, "utf8").digest("hex");
}

function headerValue(req: Request, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Extracts the negotiated TLS cipher name, or "" for a plaintext connection. */
function extractTlsCipher(req: Request): string {
  const socket = req.socket as unknown as { getCipher?: () => { name: string } | undefined };
  return socket.getCipher?.()?.name ?? "";
}

// Utility to extract fingerprint from headers/params and return a hashed value
export function extractFingerprint(req: Request): string {
  const userAgent = headerValue(req, "user-agent");
  const acceptLanguage = headerValue(req, "accept-language");
  const deviceId =
    headerValue(req, "x-device-id") || (req.query?.deviceId as string) || "";
  const ipAddress = getCurrentRequestIp(req) ?? "";
  const tlsCipher = extractTlsCipher(req);

  // Hash the combined fingerprint parts to avoid storing raw UA / IP / language
  const raw = `${userAgent}|${acceptLanguage}|${deviceId}|${ipAddress}|${tlsCipher}`;
  return hashString(raw);
}

export interface DeviceFingerprintCheck {
  fingerprint: string;
  isNewDevice: boolean;
  /** True once repeated new-device mismatches within the window exceed the threshold. */
  requiresStepUp: boolean;
}

/**
 * Records the device fingerprint for a login/authenticated request and
 * reports whether this is a device the user hasn't used before.
 *
 * Works across login sessions — every call for a given user is checked
 * against all previously seen fingerprints for that user, not just the
 * current session. Repeated new-device mismatches within a 24h window
 * flag `requiresStepUp` so the caller can demand additional verification
 * (e.g. 2FA) before completing authentication.
 */
export async function recordDeviceFingerprint(
  userId: string,
  req: Request,
): Promise<DeviceFingerprintCheck> {
  const fingerprint = extractFingerprint(req);

  const existing = await pool.query(
    "SELECT id FROM device_fingerprints WHERE user_id = $1 AND fingerprint = $2",
    [userId, fingerprint],
  );

  const isNewDevice = existing.rows.length === 0;

  if (!isNewDevice) {
    return { fingerprint, isNewDevice: false, requiresStepUp: false };
  }

  await pool.query(
    "INSERT INTO device_fingerprints (user_id, fingerprint) VALUES ($1, $2)",
    [userId, fingerprint],
  );

  console.warn(
    JSON.stringify({
      event: "device_fingerprint_changed",
      userId,
      fingerprint,
      timestamp: new Date().toISOString(),
    }),
  );

  let requiresStepUp = false;
  try {
    const mismatchKey = `fingerprint:mismatches:${userId}`;
    const count = await redisClient.incr(mismatchKey);
    if (count === 1) {
      await redisClient.expire(mismatchKey, MISMATCH_WINDOW_SECONDS);
    }
    requiresStepUp = count >= MISMATCH_STEP_UP_THRESHOLD;
  } catch (error) {
    console.error("[fingerprint] Failed to track mismatch count:", error);
  }

  return { fingerprint, isNewDevice: true, requiresStepUp };
}

// Middleware to collect and compare device fingerprints
export async function fingerprintMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const userId = (req.body as any)?.userId || (req as any).user?.id; // Adjust as per your auth
  if (!userId) return next();

  const result = await recordDeviceFingerprint(userId, req);
  req.isNewDevice = result.isNewDevice;
  next();
}
