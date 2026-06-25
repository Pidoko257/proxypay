import { Queue } from "bullmq";
import { queueOptions } from "./config";

export const MOMO_RECONCILIATION_QUEUE_NAME = "momo-reconciliation";
export const MOMO_RECONCILIATION_JOB_NAME = "reconcile-momo-transactions";

/** 10 minutes in milliseconds */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;

export interface MomoReconciliationJobData {
  triggeredBy: "scheduler";
}

export const momoReconciliationQueue = new Queue<MomoReconciliationJobData>(
  MOMO_RECONCILIATION_QUEUE_NAME,
  queueOptions,
);

function getIntervalMs(): number {
  const parsed = Number.parseInt(
    process.env.MOMO_RECONCILIATION_INTERVAL_MS || "",
    10,
  );
  return Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MS
    ? parsed
    : DEFAULT_INTERVAL_MS;
}

export async function scheduleMomoReconciliationJob(): Promise<void> {
  const every = getIntervalMs();

  await momoReconciliationQueue.add(
    MOMO_RECONCILIATION_JOB_NAME,
    { triggeredBy: "scheduler" },
    {
      jobId: MOMO_RECONCILIATION_JOB_NAME,
      repeat: { every },
      removeOnComplete: { count: 100, age: 24 * 3600 },
      removeOnFail: { count: 500, age: 7 * 24 * 3600 },
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
}

export async function closeMomoReconciliationQueue(): Promise<void> {
  await momoReconciliationQueue.close();
}
