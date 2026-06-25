import { Job, Worker } from "bullmq";
import { queueOptions } from "./config";
import {
  MOMO_RECONCILIATION_JOB_NAME,
  MOMO_RECONCILIATION_QUEUE_NAME,
  type MomoReconciliationJobData,
} from "./momoReconciliationQueue";
import { runMomoReconciliationJob } from "../jobs/momoReconciliationJob";
import logger from "../utils/logger";

let worker: Worker<MomoReconciliationJobData> | null = null;

export function startMomoReconciliationWorker(): void {
  if (worker) return;

  worker = new Worker<MomoReconciliationJobData>(
    MOMO_RECONCILIATION_QUEUE_NAME,
    async (job: Job<MomoReconciliationJobData>) => {
      logger.info(`[${MOMO_RECONCILIATION_JOB_NAME}] Running job ${job.id}`);
      return runMomoReconciliationJob();
    },
    { ...queueOptions, concurrency: 1 },
  );

  worker.on("completed", (job, result) => {
    logger.info(
      { jobId: job.id, ...result },
      `[${MOMO_RECONCILIATION_JOB_NAME}] Completed`,
    );
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, error: err.message },
      `[${MOMO_RECONCILIATION_JOB_NAME}] Failed`,
    );
  });
}

export async function closeMomoReconciliationWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = null;
}
