import { Job, Worker } from "bullmq";
import { queueOptions } from "./config";
import {
  KYC_EXPIRY_JOB_NAME,
  KYC_EXPIRY_QUEUE_NAME,
  KYCExpiryJobData,
} from "./kycExpiryQueue";
import { runKYCExpiryJob } from "../jobs/kycExpiryJob";

let kycExpiryWorkerInstance: Worker<KYCExpiryJobData> | null = null;

export function startKYCExpiryWorker(): void {
  if (kycExpiryWorkerInstance) {
    return;
  }

  kycExpiryWorkerInstance = new Worker<KYCExpiryJobData>(
    KYC_EXPIRY_QUEUE_NAME,
    async (job: Job<KYCExpiryJobData>) => {
      console.log(`[${KYC_EXPIRY_JOB_NAME}] Running job ${job.id}`);
      await runKYCExpiryJob();
    },
    {
      ...queueOptions,
      concurrency: 1,
    },
  );

  kycExpiryWorkerInstance.on("completed", (job) => {
    console.log(`[${KYC_EXPIRY_JOB_NAME}] Completed job ${job.id}`);
  });

  kycExpiryWorkerInstance.on("failed", (job, error) => {
    console.error(
      `[${KYC_EXPIRY_JOB_NAME}] Failed job ${job?.id}:`,
      error?.message,
    );
  });
}

export async function closeKYCExpiryWorker(): Promise<void> {
  if (!kycExpiryWorkerInstance) {
    return;
  }

  await kycExpiryWorkerInstance.close();
  kycExpiryWorkerInstance = null;
}