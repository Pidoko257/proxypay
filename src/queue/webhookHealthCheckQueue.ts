import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const WEBHOOK_HEALTH_CHECK_QUEUE_NAME = "webhook-health-checks";
export const WEBHOOK_HEALTH_CHECK_JOB_NAME = "check-webhook-health";

export interface WebhookHealthCheckJobData {
  triggeredBy: "scheduler";
}

/** Default: run every hour (3 600 000 ms). Override via env for testing. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000; // never faster than once a minute

export const webhookHealthCheckQueue = new Queue<WebhookHealthCheckJobData>(
  WEBHOOK_HEALTH_CHECK_QUEUE_NAME,
  queueOptions,
);

function getRepeatIntervalMs(): number {
  const raw = process.env.WEBHOOK_HEALTH_CHECK_INTERVAL_MS;
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Registers the recurring BullMQ repeat job.
 * Safe to call multiple times — BullMQ deduplicates by jobId.
 */
export async function scheduleWebhookHealthCheckJob(): Promise<void> {
  const every = getRepeatIntervalMs();

  await webhookHealthCheckQueue.add(
    WEBHOOK_HEALTH_CHECK_JOB_NAME,
    { triggeredBy: "scheduler" },
    {
      jobId: WEBHOOK_HEALTH_CHECK_JOB_NAME,
      repeat: { every },
      removeOnComplete: { count: 100, age: 24 * 3600 },
      removeOnFail: { count: 500, age: 7 * 24 * 3600 },
      attempts: Number.parseInt(
        process.env.WEBHOOK_HEALTH_CHECK_ATTEMPTS || "3",
        10,
      ),
      backoff: {
        type: "exponential",
        delay: Number.parseInt(
          process.env.WEBHOOK_HEALTH_CHECK_BACKOFF_MS || "5000",
          10,
        ),
      },
    },
  );
}

export async function closeWebhookHealthCheckQueue(): Promise<void> {
  await webhookHealthCheckQueue.close();
}
