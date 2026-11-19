import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const SAR_GENERATION_QUEUE_NAME = "sar-generation";
export const SAR_GENERATION_JOB_NAME = "generate-sar";

export interface SarGenerationJobData {
  userId: string;
  alertId: string;
}

export const sarGenerationQueue = new Queue<SarGenerationJobData>(
  SAR_GENERATION_QUEUE_NAME,
  queueOptions,
);

/**
 * Durably enqueue SAR preparation for a high-severity AML alert.
 *
 * The job id is derived from the alert id so that re-enqueueing the same
 * alert (e.g. after a retry or a severity upgrade) is idempotent.
 */
export async function enqueueSarGeneration(
  data: SarGenerationJobData,
): Promise<void> {
  await sarGenerationQueue.add(SAR_GENERATION_JOB_NAME, data, {
    jobId: `sar-${data.alertId}`,
    attempts: Number.parseInt(process.env.SAR_GENERATION_ATTEMPTS || "5", 10),
    backoff: {
      type: "exponential",
      delay: Number.parseInt(process.env.SAR_GENERATION_BACKOFF_MS || "10000", 10),
    },
    removeOnComplete: { count: 1000, age: 30 * 24 * 3600 },
    // Keep failed SAR jobs around so they can be inspected and replayed.
    removeOnFail: false,
  });
}

export async function closeSarGenerationQueue(): Promise<void> {
  await sarGenerationQueue.close();
}
