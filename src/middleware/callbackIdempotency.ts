import crypto from "node:crypto";
import { Request, Response, NextFunction, RequestHandler } from "express";
import logger from "../utils/logger";
import redisClient from "../config/redis";

export interface CallbackRecord {
  idempotencyKey: string;
  payloadHash: string;
  provider: string;
  receivedAt: Date;
  status: "received" | "processed" | "duplicate";
  responseBody?: unknown;
  statusCode?: number;
}

const DEFAULT_TTL_SECONDS = 86400; // 24 hours

function buildRedisKey(provider: string, idempotencyKey: string): string {
  return `callback:${provider}:${idempotencyKey}`;
}

export class CallbackIdempotencyStore {
  private records: Map<string, CallbackRecord> = new Map();
  private hashIndex: Map<string, string> = new Map();
  private maxEntries: number = 10000;
  private ttlMs: number = 24 * 60 * 60 * 1000; // 24 hours

  constructor(ttlMs?: number, maxEntries?: number) {
    if (ttlMs !== undefined) this.ttlMs = ttlMs;
    if (maxEntries !== undefined) this.maxEntries = maxEntries;
  }

  private get ttlSeconds(): number {
    return Math.max(1, Math.floor(this.ttlMs / 1000)) || DEFAULT_TTL_SECONDS;
  }

  hashPayload(body: unknown): string {
    return crypto
      .createHash("sha256")
      .update(typeof body === "string" ? body : JSON.stringify(body ?? {}))
      .digest("hex");
  }

  async findDuplicate(
    provider: string,
    idempotencyKey: string,
    payloadHash: string
  ): Promise<CallbackRecord | null> {
    const fullKey = `${provider}:${idempotencyKey}`;
    const record = this.records.get(fullKey);
    if (record) {
      if (Date.now() - record.receivedAt.getTime() > this.ttlMs) {
        this.records.delete(fullKey);
        this.hashIndex.delete(`${provider}:${record.payloadHash}`);
        return null;
      }
      return record;
    }

    // Also check payload hash match for this provider
    const existingKey = this.hashIndex.get(`${provider}:${payloadHash}`);
    if (existingKey) {
      const byHash = this.records.get(existingKey);
      if (byHash && Date.now() - byHash.receivedAt.getTime() <= this.ttlMs) {
        return byHash;
      }
    }

    // Fall back to Redis so duplicates are detected across restarts and replicas
    try {
      const redisKey = buildRedisKey(provider, idempotencyKey);
      const exists = await redisClient.exists(redisKey);
      if (exists) {
        return {
          idempotencyKey,
          payloadHash,
          provider,
          receivedAt: new Date(),
          status: "duplicate",
        };
      }
    } catch (err) {
      logger.error({ err, provider, idempotencyKey }, "Callback idempotency Redis lookup failed");
    }

    return null;
  }

  async recordCallback(
    provider: string,
    idempotencyKey: string,
    payloadHash: string
  ): Promise<CallbackRecord | null> {
    // Atomically claim the callback in Redis. If the key already exists, this
    // callback is a duplicate (e.g. retry landing on another replica).
    try {
      const redisKey = buildRedisKey(provider, idempotencyKey);
      const claimed = await redisClient.set(redisKey, "1", "EX", this.ttlSeconds, "NX");
      if (claimed === null) {
        return null;
      }
    } catch (err) {
      logger.error({ err, provider, idempotencyKey }, "Callback idempotency Redis claim failed");
    }

    // Evict oldest if reached capacity
    if (this.records.size >= this.maxEntries) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey) {
        const old = this.records.get(oldestKey);
        if (old) this.hashIndex.delete(`${provider}:${old.payloadHash}`);
        this.records.delete(oldestKey);
      }
    }

    const fullKey = `${provider}:${idempotencyKey}`;
    const record: CallbackRecord = {
      idempotencyKey,
      payloadHash,
      provider,
      receivedAt: new Date(),
      status: "received",
    };

    this.records.set(fullKey, record);
    this.hashIndex.set(`${provider}:${payloadHash}`, fullKey);
    return record;
  }

  markProcessed(provider: string, idempotencyKey: string, statusCode: number, responseBody: unknown): void {
    const fullKey = `${provider}:${idempotencyKey}`;
    const record = this.records.get(fullKey);
    if (record) {
      record.status = "processed";
      record.statusCode = statusCode;
      record.responseBody = responseBody;
    }
  }

  clear(): void {
    this.records.clear();
    this.hashIndex.clear();
  }

  getRecordCount(): number {
    return this.records.size;
  }
}

export const defaultCallbackStore = new CallbackIdempotencyStore();

export interface CallbackIdempotencyOptions {
  provider: string;
  store?: CallbackIdempotencyStore;
}

export function extractCallbackIdempotencyKey(req: Request, provider: string): string {
  // Check headers
  const headerKey =
    req.header("x-callback-id") ||
    req.header("x-idempotency-key") ||
    req.header("x-reference-id") ||
    req.header("x-request-id") ||
    req.header("x-correlation-id");

  if (headerKey && typeof headerKey === "string" && headerKey.trim()) {
    return headerKey.trim();
  }

  // Check body fields
  const body = req.body;
  if (body && typeof body === "object") {
    const candidate =
      body.financialTransactionId ||
      body.transactionId ||
      body.transId ||
      body.transaction_id ||
      body.tx_ref ||
      body.reference ||
      body.externalId ||
      body.id ||
      body.order_id;

    if (candidate && typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  // Fallback to SHA256 of payload
  return crypto
    .createHash("sha256")
    .update(`${provider}:${JSON.stringify(body ?? {})}`)
    .digest("hex");
}

export function callbackIdempotency(options: CallbackIdempotencyOptions): RequestHandler {
  const store = options.store || defaultCallbackStore;
  const provider = options.provider;

  return async (req: Request, res: Response, next: NextFunction) => {
    const idempotencyKey = extractCallbackIdempotencyKey(req, provider);
    const payloadHash = store.hashPayload(req.body);

    const existing = await store.findDuplicate(provider, idempotencyKey, payloadHash);

    if (existing) {
      logger.warn(
        {
          provider,
          idempotencyKey,
          payloadHash,
          originalReceivedAt: existing.receivedAt,
          status: existing.status,
        },
        `Duplicate mobile money callback detected for ${provider}; skipping processing`
      );

      res.setHeader("X-Callback-Duplicate", "true");
      res.setHeader("X-Callback-Idempotency-Key", idempotencyKey);

      // Mobile money providers require 200 OK so they do not keep retrying,
      // while duplicate indicates processing was skipped.
      return res.status(200).json({
        status: "accepted",
        duplicate: true,
        message: "Duplicate callback already processed",
        provider,
        idempotencyKey,
      });
    }

    // New callback: atomically claim it in Redis (SET NX EX). If another
    // replica already claimed it, treat this as a duplicate.
    const record = await store.recordCallback(provider, idempotencyKey, payloadHash);

    if (!record) {
      logger.warn(
        { provider, idempotencyKey, payloadHash },
        `Duplicate mobile money callback detected for ${provider} (Redis); skipping processing`
      );

      res.setHeader("X-Callback-Duplicate", "true");
      res.setHeader("X-Callback-Idempotency-Key", idempotencyKey);

      return res.status(200).json({
        status: "accepted",
        duplicate: true,
        message: "Duplicate callback already processed",
        provider,
        idempotencyKey,
      });
    }

    // Intercept response to mark processed
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      store.markProcessed(provider, idempotencyKey, res.statusCode, body);
      return originalJson(body);
    };

    next();
  };
}