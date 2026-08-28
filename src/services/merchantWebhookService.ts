import { createHmac } from "crypto";
import {
  MerchantWebhookModel,
  MerchantWebhook,
  WebhookDeliveryLog,
} from "../models/merchantWebhook";
import { SAMPLE_WEBHOOK_PAYLOAD } from "../routes/webhooks";
import {
  checkWebhookRateLimit,
  recordWebhookFailure,
  recordWebhookSuccess,
} from "./webhookRateLimiter";

const model = new MerchantWebhookModel();

const DEFAULT_TIMEOUT_MS = 10_000;

// Retry configuration defaults
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_JITTER_FACTOR = 0.2;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

// Retryable status codes (429 = rate limited, 5xx = server errors)
const DEFAULT_RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

interface DeliveryResult {
  status: "delivered" | "failed";
  httpStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  durationMs: number;
  attempts: number;
}

/**
 * Sign a payload with HMAC-SHA256 — same scheme as the existing WebhookService.
 */
function signPayload(payload: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Calculate exponential backoff delay with jitter and max cap.
 * @param baseDelayMs - Base delay in milliseconds
 * @param attempt - Current attempt number (0-indexed)
 * @param maxDelayMs - Maximum delay cap in milliseconds
 * @param jitterFactor - Jitter factor (0-1) to add randomness
 * @param backoffMultiplier - Multiplier for exponential backoff
 * @returns Delay in milliseconds
 */
function calculateBackoffDelay(
  baseDelayMs: number,
  attempt: number,
  maxDelayMs: number,
  jitterFactor: number,
  backoffMultiplier: number,
): number {
  const exponentialDelay = baseDelayMs * Math.pow(backoffMultiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  const jitter = cappedDelay * jitterFactor * Math.random();
  return Math.floor(cappedDelay + jitter);
}

/**
 * Determine if an error is retryable.
 * Retry on: network errors, timeouts, 429 (rate limited), 5xx server errors
 * Don't retry on: 4xx client errors (except 429)
 * @param error - The error that occurred
 * @param statusCode - HTTP status code if available
 * @returns true if the request should be retried
 */
function isRetryableError(
  error: unknown,
  statusCode?: number,
): boolean {
  if (statusCode !== undefined) {
    // Retry on 429 (rate limited) and 5xx server errors
    if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
      return true;
    }
    // Don't retry on other 4xx client errors
    if (statusCode >= 400 && statusCode < 500) {
      return false;
    }
  }
  // Retry on network errors (no status code)
  return true;
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deliver a single webhook payload to the given URL with exponential backoff retry.
 * Returns a structured result regardless of success/failure.
 */
async function deliverWithRetry(
  url: string,
  secret: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterFactor?: number;
    backoffMultiplier?: number;
    retryableStatusCodes?: number[];
  } = {},
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, secret);
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterFactor = options.jitterFactor ?? DEFAULT_JITTER_FACTOR;
  const backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const retryableStatusCodes = options.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;

  let lastError: string | null = null;
  let lastStatusCode: number | undefined;
  let totalDurationMs = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
            "User-Agent": "MobileMoney-Webhook/1.0",
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const durationMs = Date.now() - start;
      totalDurationMs += durationMs;
      const responseBody = await response.text().catch(() => "");

      if (response.ok) {
        return {
          status: "delivered",
          httpStatus: response.status,
          responseBody,
          errorMessage: null,
          durationMs: totalDurationMs,
          attempts: attempt + 1,
        };
      }

      lastStatusCode = response.status;
      lastError = `HTTP ${response.status}`;

      // Check if we should retry
      const isRetryable = retryableStatusCodes.includes(response.status);
      if (attempt < maxAttempts - 1 && isRetryable) {
        const delayMs = calculateBackoffDelay(
          baseDelayMs,
          attempt,
          maxDelayMs,
          jitterFactor,
          backoffMultiplier,
        );
        console.log(
          `[MerchantWebhookService] retrying in ${delayMs}ms for URL ${url} attempt=${attempt + 2}/${maxAttempts}`,
        );
        await sleep(delayMs);
        continue;
      }

      return {
        status: "failed",
        httpStatus: response.status,
        responseBody,
        errorMessage: lastError,
        durationMs: totalDurationMs,
        attempts: attempt + 1,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      totalDurationMs += durationMs;
      const errorMessage =
        err instanceof Error
          ? err.name === "AbortError"
            ? `Timeout after ${DEFAULT_TIMEOUT_MS}ms`
            : err.message
          : String(err);
      lastError = errorMessage;

      // Check if we should retry (network errors are retryable)
      if (attempt < maxAttempts - 1 && isRetryableError(err, undefined)) {
        const delayMs = calculateBackoffDelay(
          baseDelayMs,
          attempt,
          maxDelayMs,
          jitterFactor,
          backoffMultiplier,
        );
        console.log(
          `[MerchantWebhookService] retrying in ${delayMs}ms for URL ${url} attempt=${attempt + 2}/${maxAttempts}: ${errorMessage}`,
        );
        await sleep(delayMs);
        continue;
      }

      return {
        status: "failed",
        errorMessage,
        durationMs: totalDurationMs,
        attempts: attempt + 1,
      };
    }
  }

  // Should not reach here, but just in case
  return {
    status: "failed",
    httpStatus: lastStatusCode,
    errorMessage: lastError,
    durationMs: totalDurationMs,
    attempts: maxAttempts,
  };
}

export interface MerchantWebhookServiceOptions {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  backoffMultiplier?: number;
  retryableStatusCodes?: number[];
}

export class MerchantWebhookService {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterFactor: number;
  private readonly backoffMultiplier: number;
  private readonly retryableStatusCodes: number[];

  constructor(options: MerchantWebhookServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.jitterFactor = options.jitterFactor ?? DEFAULT_JITTER_FACTOR;
    this.backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    this.retryableStatusCodes = options.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;
  }

  /**
   * Send a test delivery using the canonical sample payload.
   * Records the attempt in webhook_delivery_logs with is_test=true.
   */
  async testWebhook(
    webhookId: string,
    userId: string,
  ): Promise<{ log: WebhookDeliveryLog; webhook: MerchantWebhook }> {
    const webhook = await model.findById(webhookId, userId);
    if (!webhook) throw new Error("Webhook not found");

    const rateLimitResult = await checkWebhookRateLimit(userId);
    if (!rateLimitResult.allowed) {
      throw new Error(
        `Rate limit exceeded. Retry after ${rateLimitResult.retryAfterSecs ?? 1} second(s).`,
      );
    }

    const payload = {
      ...SAMPLE_WEBHOOK_PAYLOAD,
      timestamp: new Date().toISOString(),
    };

    const result = await deliverWithRetry(
      webhook.url,
      webhook.secret,
      payload,
      this.fetchImpl,
      {
        maxAttempts: this.maxAttempts,
        baseDelayMs: this.baseDelayMs,
        maxDelayMs: this.maxDelayMs,
        jitterFactor: this.jitterFactor,
        backoffMultiplier: this.backoffMultiplier,
        retryableStatusCodes: this.retryableStatusCodes,
      },
    );

    if (result.status === "delivered") {
      await recordWebhookSuccess(userId);
    } else {
      await recordWebhookFailure(userId);
    }

    const log = await model.insertDeliveryLog({
      webhookId: webhook.id,
      eventType: "transaction.completed",
      payload,
      status: result.status,
      httpStatus: result.httpStatus,
      responseBody: result.responseBody,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
      isTest: true,
    });

    return { log, webhook };
  }

  /**
   * Deliver a real event to all active webhooks for a user that subscribe to the event.
   * Called by the transaction worker after status changes.
   */
  async dispatchEvent(
    userId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const rateLimitResult = await checkWebhookRateLimit(userId);
    if (!rateLimitResult.allowed) {
      console.warn(
        `[MerchantWebhookService] Rate limit exceeded for merchant ${userId}. ` +
          `Retry after ${rateLimitResult.retryAfterSecs ?? 1}s. isAdaptive=${rateLimitResult.isAdaptive}`,
      );
      return;
    }

    const webhooks = await model.findByUserId(userId);
    const active = webhooks.filter((w) => w.isActive && w.events.includes(eventType));

    await Promise.allSettled(
      active.map(async (webhook) => {
        const result = await deliverWithRetry(
          webhook.url,
          webhook.secret,
          payload,
          this.fetchImpl,
          {
            maxAttempts: this.maxAttempts,
            baseDelayMs: this.baseDelayMs,
            maxDelayMs: this.maxDelayMs,
            jitterFactor: this.jitterFactor,
            backoffMultiplier: this.backoffMultiplier,
            retryableStatusCodes: this.retryableStatusCodes,
          },
        );

        if (result.status === "delivered") {
          await recordWebhookSuccess(userId);
        } else {
          await recordWebhookFailure(userId);
        }

        await model.insertDeliveryLog({
          webhookId: webhook.id,
          eventType,
          payload,
          status: result.status,
          httpStatus: result.httpStatus,
          responseBody: result.responseBody,
          errorMessage: result.errorMessage,
          durationMs: result.durationMs,
          isTest: false,
        });
      }),
    );
  }
}

export const merchantWebhookService = new MerchantWebhookService();
export { model as merchantWebhookModel };

// Export utility functions for testing
export { deliverWithRetry, calculateBackoffDelay, isRetryableError, sleep, signPayload };
