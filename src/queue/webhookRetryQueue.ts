import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const WEBHOOK_RETRY_QUEUE_NAME = "webhook-retry";

export interface WebhookRetryJobData {
  webhookId: string;
  endpointUrl: string;
  secret: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export const webhookRetryQueue = new Queue<WebhookRetryJobData>(
  WEBHOOK_RETRY_QUEUE_NAME,
  {
    ...queueOptions,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  }
);

export async function enqueueWebhookRetry(
  data: WebhookRetryJobData,
  delayMs?: number
): Promise<void> {
  const jobId = `webhook-retry-${data.webhookId}-${data.eventType}-${Date.now()}`;
  await webhookRetryQueue.add(
    "send-webhook",
    data,
    {
      jobId,
      delay: delayMs,
    }
  );
}
