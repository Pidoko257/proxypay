import { JobsOptions, Queue } from "bullmq";
import { queueOptions } from "./config";

export const WEBHOOK_DELIVERY_QUEUE_NAME = "webhook-deliveries";
export const WEBHOOK_DELIVERY_JOB_NAME = "deliver-webhook";
export const WEBHOOK_BACKOFF_STRATEGY = "webhook-exponential";
export const WEBHOOK_BACKOFF_DELAYS_MS = [1000, 5000, 30000, 300000, 1800000];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_DELAYS_MS.length + 1;

export interface WebhookDeliveryJobData {
  webhookId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export const webhookDeliveryQueue = new Queue<WebhookDeliveryJobData>(
  WEBHOOK_DELIVERY_QUEUE_NAME,
  queueOptions,
);

export function webhookBackoffStrategy(attemptsMade: number): number {
  return WEBHOOK_BACKOFF_DELAYS_MS[attemptsMade - 1] ?? -1;
}

export async function addWebhookDeliveryJob(
  data: WebhookDeliveryJobData,
  options: JobsOptions = {},
) {
  return webhookDeliveryQueue.add(WEBHOOK_DELIVERY_JOB_NAME, data, {
    attempts: WEBHOOK_MAX_ATTEMPTS,
    backoff: {
      type: WEBHOOK_BACKOFF_STRATEGY,
    },
    removeOnComplete: {
      count: 1000,
      age: 7 * 24 * 3600,
    },
    removeOnFail: {
      count: 5000,
      age: 30 * 24 * 3600,
    },
    ...options,
  });
}

export async function closeWebhookDeliveryQueue(): Promise<void> {
  await webhookDeliveryQueue.close();
}
