import axios, { AxiosResponse } from "axios";
import { Job, Worker } from "bullmq";
import { createHmac } from "crypto";
import { queueOptions } from "./config";
import {
  WEBHOOK_BACKOFF_STRATEGY,
  WEBHOOK_DELIVERY_QUEUE_NAME,
  WEBHOOK_MAX_ATTEMPTS,
  WebhookDeliveryJobData,
  webhookBackoffStrategy,
} from "./webhookDeliveryQueue";
import {
  WEBHOOK_DELIVERY_FAILED_EVENT,
  webhookEvents,
} from "../events/webhookEvents";
import { MerchantWebhookModel } from "../models/merchantWebhook";
import logger from "../utils/logger";

const WEBHOOK_TIMEOUT_MS = 30_000;

let webhookDeliveryWorker: Worker<WebhookDeliveryJobData> | null = null;
const model = new MerchantWebhookModel();

function signPayload(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function responseBodyToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === undefined || data === null) return "";

  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function deliverWebhook(job: Job<WebhookDeliveryJobData>): Promise<void> {
  const { webhookId, eventType, payload } = job.data;
  const webhook = await model.findById(webhookId);
  const attemptNumber = job.attemptsMade + 1;

  if (!webhook) {
    throw new Error(`Webhook ${webhookId} not found`);
  }

  if (!webhook.isActive || !webhook.events.includes(eventType)) {
    logger.info({ webhookId, eventType }, "Skipping inactive or unsubscribed webhook");
    return;
  }

  const body = JSON.stringify(payload);
  const signature = signPayload(body, webhook.secret);
  const startedAt = Date.now();
  let response: AxiosResponse<unknown> | undefined;

  try {
    response = await axios.post(webhook.url, body, {
      timeout: WEBHOOK_TIMEOUT_MS,
      validateStatus: () => true,
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "User-Agent": "MobileMoney-Webhook/1.0",
      },
    });

    const durationMs = Date.now() - startedAt;
    const responseBody = responseBodyToString(response.data);
    const delivered = response.status >= 200 && response.status < 300;

    await model.insertDeliveryAttempt({
      webhookId,
      eventType,
      payload,
      status: delivered ? "delivered" : "failed",
      httpStatus: response.status,
      responseBody,
      errorMessage: delivered ? undefined : `HTTP ${response.status}`,
      durationMs,
      attemptNumber,
      jobId: job.id,
    });

    if (!delivered) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const httpStatus = response?.status;
    const responseBody = response ? responseBodyToString(response.data) : undefined;
    const errorMessage = getErrorMessage(error);

    if (!response) {
      await model.insertDeliveryAttempt({
        webhookId,
        eventType,
        payload,
        status: "failed",
        httpStatus,
        responseBody,
        errorMessage,
        durationMs,
        attemptNumber,
        jobId: job.id,
      });
    }

    if (attemptNumber >= WEBHOOK_MAX_ATTEMPTS) {
      webhookEvents.emit(WEBHOOK_DELIVERY_FAILED_EVENT, {
        webhookId,
        eventType,
        jobId: job.id,
        attemptsMade: attemptNumber,
        errorMessage,
      });
    }

    throw error;
  }
}

export function startWebhookDeliveryWorker(): void {
  if (webhookDeliveryWorker) {
    return;
  }

  webhookDeliveryWorker = new Worker<WebhookDeliveryJobData>(
    WEBHOOK_DELIVERY_QUEUE_NAME,
    deliverWebhook,
    {
      ...queueOptions,
      concurrency: Number.parseInt(process.env.WEBHOOK_DELIVERY_CONCURRENCY || "5", 10),
      settings: {
        ...queueOptions.settings,
        backoffStrategy: (attemptsMade, type) => {
          if (type === WEBHOOK_BACKOFF_STRATEGY) {
            return webhookBackoffStrategy(attemptsMade);
          }
          return 0;
        },
      },
    },
  );

  webhookDeliveryWorker.on("failed", (job, error) => {
    logger.warn(
      {
        jobId: job?.id,
        webhookId: job?.data.webhookId,
        eventType: job?.data.eventType,
        attemptsMade: job?.attemptsMade,
        error,
      },
      "Webhook delivery attempt failed",
    );
  });
}

export async function closeWebhookDeliveryWorker(): Promise<void> {
  if (!webhookDeliveryWorker) {
    return;
  }

  await webhookDeliveryWorker.close();
  webhookDeliveryWorker = null;
}

export { WEBHOOK_TIMEOUT_MS };
