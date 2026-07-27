import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { redisClient } from "../config/redis";
import {
  deduplicationRequestsTotal,
  deduplicationHitsTotal,
  deduplicationRedisErrorsTotal,
} from "../utils/metrics";

const DEDUPLICATION_TTL_SECONDS = parseInt(
  process.env.DEDUPLICATION_TTL_SECONDS || "60",
  10,
);

const ADMIN_BYPASS_HEADER = "x-deduplication-bypass";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

interface DeduplicationOptions {
  ttlSeconds?: number;
  adminBypassHeader?: string;
  maxBodyBytes?: number;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return value.toString("hex");
  }

  const entries: Array<{ key: string; value: string }> = [];
  const keys = Object.keys(value as Record<string, unknown>);
  keys.sort();
  for (const key of keys) {
    entries.push({ key, value: stableStringify((value as Record<string, unknown>)[key]) });
  }
  return "{" + entries.map(({ key, value }) => `${key}:${value}`).join(",") + "}";
}

export function buildRequestFingerprint(
  req: Request,
  options: DeduplicationOptions = {},
): string {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const method = req.method.toUpperCase();
  const originalUrl = req.originalUrl || req.url || "/";

  const urlObj = new URL(originalUrl, "http://localhost");
  const sortedQuery = Array.from(urlObj.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  let bodyHash = "";
  if (
    req.body !== undefined &&
    req.body !== null &&
    (method === "POST" || method === "PUT" || method === "PATCH")
  ) {
    const bodyString = stableStringify(req.body);
    const buf = Buffer.from(bodyString, "utf8").slice(0, maxBodyBytes);
    bodyHash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
  }

  const accept =
    (Array.isArray(req.headers["accept"])
      ? req.headers["accept"][0]
      : req.headers["accept"]) || "";
  const contentType =
    (Array.isArray(req.headers["content-type"])
      ? req.headers["content-type"][0]
      : req.headers["content-type"]) || "";

  const raw = [
    method,
    urlObj.pathname,
    sortedQuery,
    contentHash(accept),
    contentHash(contentType),
    bodyHash,
  ].join("|");

  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function contentHash(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 12);
}

export function isDeduplicationBypassed(req: Request): boolean {
  const headerValue = req.get
    ? req.get(ADMIN_BYPASS_HEADER)
    : (req.headers[ADMIN_BYPASS_HEADER.toLowerCase()] as string | undefined);
  const bypass = headerValue ?? (process.env.DEDUPLICATION_ADMIN_BYPASS === "true");
  if (typeof bypass === "string") {
    return bypass.toLowerCase() === "true" || bypass === "1";
  }
  return Boolean(bypass);
}

export function isAdminRequest(req: Request): boolean {
  const user = (req as Request & { user?: { role?: string } }).user;
  if (!user) return false;
  const role = user.role?.toLowerCase() || "";
  return role === "admin" || role === "super-admin";
}

export class DeduplicationError extends Error {
  constructor(
    public readonly key: string,
    public readonly cachedStatus: number,
    message?: string,
  ) {
    super(message ?? `Duplicate request blocked for key: ${key}`);
    this.name = "DeduplicationError";
  }
}

export async function storeFingerprint(
  fingerprint: string,
  ttlSeconds: number = DEDUPLICATION_TTL_SECONDS,
): Promise<void> {
  if (!redisClient || !redisClient.isOpen) return;
  try {
    await redisClient.setEx(`dedup:fp:${fingerprint}`, ttlSeconds, "1");
  } catch (error) {
    deduplicationRedisErrorsTotal.inc();
    console.error("[Deduplication] Failed to store fingerprint", error);
  }
}

export async function getCachedResponse<T>(
  fingerprint: string,
): Promise<{ hit: true; status: number; body: T } | { hit: false }> {
  if (!redisClient || !redisClient.isOpen) {
    return { hit: false };
  }

  try {
    const key = `dedup:resp:${fingerprint}`;
    const raw = await redisClient.get(key);
    if (!raw) {
      return { hit: false };
    }

    const parsed = JSON.parse(raw as string) as { status: number; body: T };
    return { hit: true, status: parsed.status, body: parsed.body };
  } catch (error) {
    deduplicationRedisErrorsTotal.inc();
    console.error("[Deduplication] Failed to retrieve cached response", error);
    return { hit: false };
  }
}

export async function cacheResponse<T>(
  fingerprint: string,
  status: number,
  body: T,
  ttlSeconds: number = DEDUPLICATION_TTL_SECONDS,
): Promise<void> {
  if (!redisClient || !redisClient.isOpen) return;
  if (status < 200 || status >= 300) return;

  try {
    const key = `dedup:resp:${fingerprint}`;
    await redisClient.setEx(key, ttlSeconds, JSON.stringify({ status, body }));
  } catch (error) {
    deduplicationRedisErrorsTotal.inc();
    console.error("[Deduplication] Failed to cache response", error);
  }
}

export function requestDeduplication(options: DeduplicationOptions = {}) {
  const ttlSeconds = options.ttlSeconds ?? DEDUPLICATION_TTL_SECONDS;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    deduplicationRequestsTotal.inc();

    if (isDeduplicationBypassed(req) || isAdminRequest(req)) {
      return next();
    }

    const fingerprint = buildRequestFingerprint(req, options);
    (req as Request & { deduplicationFingerprint?: string }).deduplicationFingerprint = fingerprint;

    const collisionCheckKey = `dedup:fp:${fingerprint}`;
    if (!redisClient || !redisClient.isOpen) {
      return next();
    }

    try {
      const exists = await redisClient.exists(collisionCheckKey);
      if (exists === 1) {
        const cached = await getCachedResponse(fingerprint);
        if (cached.hit) {
          deduplicationHitsTotal.inc();
          res.status(cached.status).json(cached.body);
          return;
        }

        deduplicationHitsTotal.inc();
        throw new DeduplicationError(fingerprint, 409, "Duplicate request detected");
      }

      const originalJson = res.json.bind(res);
      let responseBody: unknown = null;

      res.json = (body: unknown): Response => {
        responseBody = body;
        return originalJson(body);
      };

      res.on("finish", async () => {
        const statusCode = res.statusCode;
        if (statusCode >= 200 && statusCode < 300) {
          await storeFingerprint(fingerprint, ttlSeconds);
          if (responseBody !== null && responseBody !== undefined) {
            await cacheResponse(fingerprint, statusCode, responseBody, ttlSeconds);
          }
        }
      });

      next();
    } catch (error) {
      if (error instanceof DeduplicationError) {
        return next(error);
      }
      console.error("[Deduplication] Middleware error", error);
      next();
    }
  };
}
