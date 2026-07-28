import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const API_KEY_EXPIRY_WARNING_QUEUE_NAME = "api-key-expiry-warnings";
export const API_KEY_EXPIRY_WARNING_JOB_NAME = "send-api-key-expiry-warnings";
const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ApiKeyExpiryWarningJobData {
  triggeredBy: "schedule";
}

export const apiKeyExpiryWarningQueue = new Queue<ApiKeyExpiryWarningJobData>(
  API_KEY_EXPIRY_WARNING_QUEUE_NAME,
  queueOptions,
);

export async function scheduleApiKeyExpiryWarningJob(): Promise<void> {
  await apiKeyExpiryWarningQueue.add(
    API_KEY_EXPIRY_WARNING_JOB_NAME,
    { triggeredBy: "schedule" },
    {
      jobId: API_KEY_EXPIRY_WARNING_JOB_NAME,
      repeat: { every: WEEKLY_INTERVAL_MS },
      removeOnComplete: { count: 20, age: 30 * 24 * 60 * 60 },
      removeOnFail: { count: 50, age: 30 * 24 * 60 * 60 },
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
}

export async function closeApiKeyExpiryWarningQueue(): Promise<void> {
  await apiKeyExpiryWarningQueue.close();
}
