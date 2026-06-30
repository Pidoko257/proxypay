import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const KYC_EXPIRY_QUEUE_NAME = "kyc-expiry";
export const KYC_EXPIRY_JOB_NAME = "check-kyc-expiry";

export interface KYCExpiryJobData {
  triggeredBy: "scheduler";
}

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const kycExpiryQueue = new Queue<KYCExpiryJobData>(
  KYC_EXPIRY_QUEUE_NAME,
  queueOptions,
);

export async function scheduleKYCExpiryJob(): Promise<void> {
  await kycExpiryQueue.add(
    KYC_EXPIRY_JOB_NAME,
    { triggeredBy: "scheduler" },
    {
      jobId: KYC_EXPIRY_JOB_NAME,
      repeat: { every: DAILY_INTERVAL_MS },
      removeOnComplete: {
        count: 100,
        age: 24 * 3600,
      },
      removeOnFail: {
        count: 500,
        age: 7 * 24 * 3600,
      },
      attempts: Number.parseInt(process.env.KYC_EXPIRY_ATTEMPTS || "3", 10),
      backoff: {
        type: "exponential",
        delay: Number.parseInt(process.env.KYC_EXPIRY_BACKOFF_MS || "5000", 10),
      },
    },
  );
}

export async function closeKYCExpiryQueue(): Promise<void> {
  await kycExpiryQueue.close();
}