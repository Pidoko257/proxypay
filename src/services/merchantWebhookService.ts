import { createHmac } from "crypto";
import {
  MerchantWebhookModel,
  MerchantWebhook,
  WebhookDeliveryLog,
} from "../models/merchantWebhook";
import { SAMPLE_WEBHOOK_PAYLOAD } from "../routes/webhooks";

const model = new MerchantWebhookModel();

const DEFAULT_TIMEOUT_MS = 10_000;

interface DeliveryResult {
  status: "delivered" | "failed";
  httpStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  durationMs: number;
}

/**
 * Sign a payload with HMAC-SHA256 — same scheme as the existing WebhookService.
 */
function signPayload(payload: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Deliver a single webhook payload to the given URL.
 * Returns a structured result regardless of success/failure.
 */
async function deliver(
  url: string,
  secret: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, secret);
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
    const responseBody = await response.text().catch(() => "");

    if (response.ok) {
      return { status: "delivered", httpStatus: response.status, responseBody, durationMs };
    }
    return {
      status: "failed",
      httpStatus: response.status,
      responseBody,
      errorMessage: `HTTP ${response.status}`,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const errorMessage =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Timeout after ${DEFAULT_TIMEOUT_MS}ms`
          : err.message
        : String(err);
    return { status: "failed", errorMessage, durationMs };
  }
}

export class MerchantWebhookService {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /**
   * Return the list of available event topics, including wildcard topics.
   * Useful for the UI and documentation.
   */
  listTopics() {
    return model.listAvailableTopics();
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

    const payload = {
      ...SAMPLE_WEBHOOK_PAYLOAD,
      timestamp: new Date().toISOString(),
    };

    const result = await deliver(webhook.url, webhook.secret, payload, this.fetchImpl);

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
   * Deliver a real event to all active webhooks for a user whose topic
   * subscriptions match the given eventType (including wildcard matching).
   *
   * Called by the transaction worker after status changes.
   */
  async dispatchEvent(
    userId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Use the topic-aware query so wildcard subscriptions are resolved correctly
    const matchingWebhooks = await model.findActiveByUserIdAndTopic(userId, eventType);

    await Promise.allSettled(
      matchingWebhooks.map(async (webhook) => {
        const result = await deliver(webhook.url, webhook.secret, payload, this.fetchImpl);
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
