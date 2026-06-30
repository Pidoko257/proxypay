import { timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { getConfigValue } from "../config/appConfig";
import { getCurrentRequestIp, logSecurityAnomaly } from "../services/logger";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "./errorHandler";

function getAirtelCallbackSecret(): string {
  const secret = getConfigValue("providers.airtel.callbackSecret");
  return String(secret ?? "").trim();
}

function extractBearerToken(req: Request): string | undefined {
  const authHeader = req.headers["authorization"] as string | undefined;
  if (!authHeader) return undefined;
  const parts = authHeader.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }
  return undefined;
}

function buildAirtelFailureEvent(
  req: Request,
  reason: string,
  headerPresent: boolean,
): void {
  logSecurityAnomaly({
    event: "security.anomaly",
    timestamp: new Date().toISOString(),
    path: req.originalUrl || req.url,
    method: req.method,
    ip: getCurrentRequestIp(req),
    reason,
    provider: "airtel",
    headerPresent,
  });
}

export async function verifyAirtelCallbackSignature(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const callbackSecret = getAirtelCallbackSecret();

  if (!callbackSecret) {
    buildAirtelFailureEvent(req, "airtel_callback_secret_not_configured", false);
    res.status(500).json({ error: "Airtel callback verification not configured" });
    return;
  }

  const token = extractBearerToken(req);

  if (!token) {
    buildAirtelFailureEvent(req, "airtel_callback_token_missing", false);
    throw createError(ERROR_CODES.FORBIDDEN, "Forbidden", {
      error: "Forbidden",
    });
  }

  try {
    const expectedBuf = Buffer.from(callbackSecret);
    const incomingBuf = Buffer.from(token);

    const isValid =
      expectedBuf.length === incomingBuf.length &&
      timingSafeEqual(expectedBuf, incomingBuf);

    if (!isValid) {
      buildAirtelFailureEvent(req, "airtel_callback_token_invalid", true);
      throw createError(ERROR_CODES.FORBIDDEN, "Forbidden", {
        error: "Forbidden",
      });
    }

    next();
  } catch (error: any) {
    // Re-throw structured errors (from createError) directly
    if (error?.code === ERROR_CODES.FORBIDDEN) {
      throw error;
    }
    buildAirtelFailureEvent(req, "airtel_callback_token_error", true);
    throw createError(ERROR_CODES.FORBIDDEN, "Forbidden", {
      error: "Forbidden",
    });
  }
}
