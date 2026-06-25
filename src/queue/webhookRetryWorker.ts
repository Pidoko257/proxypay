import { Worker, Job } from "bullmq";
import { createHmac } from "crypto";
import { queueOptions } from "./config";
import { WEBHOOK_RETRY_QUEUE_NAME, webhookRetryQueue, WebhookRetryJobData } from "./webhookRetryQueue";
import { MerchantWebhookModel } from "../models/merchantWebhook";

const model = new MerchantWebhookModel();
const DEFAULT_TIMEOUT_MS = 10_000;

function signPayload(payload: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

export const webhookRetryWorker = new Worker<WebhookRetryJobData>(
  WEBHOOK_RETRY_QUEUE_NAME,
  async (job: Job<WebhookRetryJobData>) => {
    const { webhookId, endpointUrl, secret, eventType, payload } = job.data;

    const body = JSON.stringify(payload);
    const signature = signPayload(body, secret);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "User-Agent": "MobileMoney-Webhook/1.0",
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => "");
        throw new Error(`HTTP error ${response.status}: ${responseText}`);
      }

      await model.insertDeliveryLog({
        webhookId,
        eventType,
        payload,
        status: "delivered",
        httpStatus: response.status,
        durationMs: Date.now() - job.timestamp,
        isTest: false,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Timeout after ${DEFAULT_TIMEOUT_MS}ms`);
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      await model.insertDeliveryLog({
        webhookId,
        eventType,
        payload,
        status: "failed",
        errorMessage,
        durationMs: Date.now() - job.timestamp,
        isTest: false,
      });

      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
  queueOptions
);

export async function closeWebhookRetryWorker() {
  await webhookRetryWorker.close();
  await webhookRetryQueue.close();
}
