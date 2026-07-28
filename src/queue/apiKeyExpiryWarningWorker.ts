import { Job, Worker } from "bullmq";
import { runApiKeyExpiryWarningJob } from "../jobs/apiKeyExpiryWarningJob";
import { queueOptions } from "./config";
import {
  API_KEY_EXPIRY_WARNING_JOB_NAME,
  API_KEY_EXPIRY_WARNING_QUEUE_NAME,
  ApiKeyExpiryWarningJobData,
} from "./apiKeyExpiryWarningQueue";

let apiKeyExpiryWarningWorker: Worker<ApiKeyExpiryWarningJobData> | null = null;

export function startApiKeyExpiryWarningWorker(): void {
  if (apiKeyExpiryWarningWorker) return;

  apiKeyExpiryWarningWorker = new Worker<ApiKeyExpiryWarningJobData>(
    API_KEY_EXPIRY_WARNING_QUEUE_NAME,
    async (_job: Job<ApiKeyExpiryWarningJobData>) => {
      await runApiKeyExpiryWarningJob();
    },
    { ...queueOptions, concurrency: 1 },
  );

  apiKeyExpiryWarningWorker.on("completed", (job) => {
    console.log(`[${API_KEY_EXPIRY_WARNING_JOB_NAME}] Completed job ${job.id}`);
  });

  apiKeyExpiryWarningWorker.on("failed", (job, error) => {
    console.error(
      `[${API_KEY_EXPIRY_WARNING_JOB_NAME}] Failed job ${job?.id}:`,
      error.message,
    );
  });
}

export async function closeApiKeyExpiryWarningWorker(): Promise<void> {
  if (!apiKeyExpiryWarningWorker) return;

  await apiKeyExpiryWarningWorker.close();
  apiKeyExpiryWarningWorker = null;
}
