import Queue, { Queue as BullQueue, Job } from "bull";
import { redis } from "../config/redis";
import { walletReconciliationService } from "../services/walletReconciliationService";
import logger from "../utils/logger";

export type ReconciliationJobType = "stellar_ledger" | "vault" | "user_wallet";

export interface ReconciliationJobData {
  jobType: ReconciliationJobType;
  userId?: string;
  vaultId?: string;
  priority?: "low" | "normal" | "high";
  retryCount?: number;
}

let reconciliationQueue: BullQueue<ReconciliationJobData> | null = null;

/**
 * Initialize the reconciliation queue
 */
export function initializeReconciliationQueue(): BullQueue<ReconciliationJobData> {
  if (reconciliationQueue) {
    return reconciliationQueue;
  }

  reconciliationQueue = new Queue("reconciliation", {
    redis: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379"),
      db: 0,
    },
  });

  // Process reconciliation jobs
  reconciliationQueue.process(
    "*",
    parseInt(process.env.RECONCILIATION_CONCURRENCY || "2", 10),
    async (job: Job<ReconciliationJobData>) => {
      logger.info(`[Reconciliation Queue] Processing job ${job.id}: ${job.data.jobType}`);

      try {
        let result;

        switch (job.data.jobType) {
          case "stellar_ledger":
            result = await walletReconciliationService.reconcileAllWallets();
            break;

          case "user_wallet":
            if (!job.data.userId) throw new Error("userId required for user_wallet job");
            result = await walletReconciliationService.triggerManualReconciliation(
              job.data.userId,
            );
            break;

          case "vault":
            // TODO: Implement vault reconciliation
            result = { status: "completed" };
            break;

          default:
            throw new Error(`Unknown job type: ${job.data.jobType}`);
        }

        logger.info(`[Reconciliation Queue] Job ${job.id} completed successfully`);
        return result;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[Reconciliation Queue] Job ${job.id} failed: ${errorMsg}`);

        // Retry logic
        const retryCount = (job.data.retryCount || 0) + 1;
        const maxRetries = 3;

        if (retryCount < maxRetries) {
          logger.info(`[Reconciliation Queue] Retrying job ${job.id} (attempt ${retryCount}/${maxRetries})`);
          throw new Error(`${errorMsg} (retry ${retryCount}/${maxRetries})`);
        }

        throw error;
      }
    },
  );

  // Event handlers
  reconciliationQueue.on("completed", (job: Job<ReconciliationJobData>) => {
    logger.info(`[Reconciliation Queue] Job ${job.id} completed`);
  });

  reconciliationQueue.on("failed", (job: Job<ReconciliationJobData>, err: Error) => {
    logger.error(`[Reconciliation Queue] Job ${job.id} failed: ${err.message}`);
  });

  reconciliationQueue.on("active", (job: Job<ReconciliationJobData>) => {
    logger.debug(`[Reconciliation Queue] Job ${job.id} is now active`);
  });

  return reconciliationQueue;
}

/**
 * Add reconciliation job to queue
 */
export async function addReconciliationJob(
  data: ReconciliationJobData,
  options?: { delay?: number; removeOnComplete?: boolean },
): Promise<Job<ReconciliationJobData>> {
  const queue = initializeReconciliationQueue();

  const jobOptions: any = {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: options?.removeOnComplete ?? false,
  };

  if (options?.delay) {
    jobOptions.delay = options.delay;
  }

  // Set priority based on data.priority
  if (data.priority === "high") {
    jobOptions.priority = 1;
  } else if (data.priority === "low") {
    jobOptions.priority = 10;
  } else {
    jobOptions.priority = 5;
  }

  logger.info(
    `[Reconciliation Queue] Adding job: ${data.jobType}${data.userId ? ` for user ${data.userId}` : ""}`,
  );

  return queue.add(data, jobOptions);
}

/**
 * Schedule hourly reconciliation job
 */
export async function scheduleHourlyReconciliation(): Promise<void> {
  const queue = initializeReconciliationQueue();

  // Remove any existing hourly jobs
  const existingJobs = await queue.getRepeatableJobs();
  const hourlyJob = existingJobs.find((job) => job.name === "stellar_ledger_hourly");

  if (hourlyJob) {
    await queue.removeRepeatableByKey(hourlyJob.key);
    logger.info("[Reconciliation Queue] Removed existing hourly job");
  }

  // Schedule new hourly job
  await queue.add(
    { jobType: "stellar_ledger", priority: "normal" },
    {
      repeat: {
        every: 60 * 60 * 1000, // 1 hour
      },
      jobId: "stellar_ledger_hourly",
    },
  );

  logger.info("[Reconciliation Queue] Scheduled hourly reconciliation job");
}

/**
 * Get queue stats
 */
export async function getReconciliationQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = initializeReconciliationQueue();

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
  };
}

/**
 * Cancel reconciliation job
 */
export async function cancelReconciliationJob(jobId: string | number): Promise<boolean> {
  const queue = initializeReconciliationQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    return false;
  }

  await job.remove();
  return true;
}

/**
 * Get job status
 */
export async function getReconciliationJobStatus(
  jobId: string | number,
): Promise<any | null> {
  const queue = initializeReconciliationQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    return null;
  }

  return {
    id: job.id,
    type: job.data.jobType,
    status: job.getState(),
    progress: job.progress(),
    attempts: job.attemptsMade,
    failedReason: job.failedReason,
    stacktrace: job.stacktrace,
    createdAt: new Date(job.timestamp),
  };
}

/**
 * Clear queue (use with caution)
 */
export async function clearReconciliationQueue(): Promise<void> {
  const queue = initializeReconciliationQueue();
  await queue.empty();
  logger.warn("[Reconciliation Queue] Queue cleared");
}

/**
 * Gracefully close queue
 */
export async function closeReconciliationQueue(): Promise<void> {
  if (reconciliationQueue) {
    await reconciliationQueue.close();
    reconciliationQueue = null;
    logger.info("[Reconciliation Queue] Queue closed");
  }
}
