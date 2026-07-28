import { Worker, Queue } from "bullmq";
import logger from "../utils/logger";

const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

interface WorkerShutdownConfig {
  worker: Worker;
  queue?: Queue;
  workerName: string;
}

interface ShutdownState {
  isShuttingDown: boolean;
  workers: Map<string, WorkerShutdownConfig>;
}

const shutdownState: ShutdownState = {
  isShuttingDown: false,
  workers: new Map(),
};

/**
 * Register a worker for graceful shutdown handling
 */
export function registerWorkerForShutdown(config: WorkerShutdownConfig): void {
  shutdownState.workers.set(config.workerName, config);
  logger.info(`[GracefulShutdown] Registered worker: ${config.workerName}`);
}

/**
 * Handle graceful shutdown for all registered BullMQ workers
 */
export async function handleBullMQGracefulShutdown(): Promise<void> {
  if (shutdownState.isShuttingDown) {
    logger.warn("[GracefulShutdown] Shutdown already in progress");
    return;
  }

  shutdownState.isShuttingDown = true;
  logger.info("[GracefulShutdown] Starting BullMQ worker graceful shutdown...");

  const workerEntries = Array.from(shutdownState.workers.entries());
  
  if (workerEntries.length === 0) {
    logger.info("[GracefulShutdown] No BullMQ workers registered for shutdown");
    return;
  }

  // Step 1: Pause all queues to stop new job pickup
  logger.info("[GracefulShutdown] Pausing all queues to stop new job pickup");
  const pausePromises = workerEntries
    .filter(([, config]) => config.queue)
    .map(async ([workerName, config]) => {
      try {
        await config.queue!.pause();
        logger.info(`[GracefulShutdown] Paused queue for ${workerName}`);
      } catch (error) {
        logger.error(`[GracefulShutdown] Failed to pause queue for ${workerName}:`, error);
      }
    });

  await Promise.allSettled(pausePromises);

  // Step 2: Wait for active jobs to complete with timeout
  logger.info(
    `[GracefulShutdown] Waiting up to ${SHUTDOWN_TIMEOUT_MS}ms for active jobs to complete`,
  );

  const startTime = Date.now();
  const waitForJobsPromises = workerEntries.map(
    async ([workerName, config]) => {
      try {
        const worker = config.worker;
        
        // Wait for worker to finish active jobs
        await Promise.race([
          worker.close(),
          new Promise<void>((resolve) => {
            setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
          }),
        ]);

        const elapsed = Date.now() - startTime;
        logger.info(
          `[GracefulShutdown] Worker ${workerName} closed in ${elapsed}ms`,
        );
      } catch (error) {
        logger.error(`[GracefulShutdown] Error closing worker ${workerName}:`, error);
      }
    },
  );

  await Promise.allSettled(waitForJobsPromises);

  // Step 3: Check for incomplete jobs and mark as failed
  logger.info("[GracefulShutdown] Checking for incomplete jobs");
  for (const [workerName, config] of workerEntries) {
    try {
      const worker = config.worker;
      const activeJobs = await worker.getRunningJobs();
      
      if (activeJobs.length > 0) {
        logger.warn(
          `[GracefulShutdown] Found ${activeJobs.length} incomplete jobs for ${workerName}`,
        );
        
        // Mark incomplete jobs as failed with SHUTDOWN_INTERRUPTED reason
        for (const job of activeJobs) {
          try {
            await job.moveToFailed(
              {
                message: "Job interrupted by graceful shutdown",
                name: "SHUTDOWN_INTERRUPTED",
              },
              true, // discard job to prevent retries
            );
            logger.info(
              `[GracefulShutdown] Marked job ${job.id} as failed due to shutdown`,
            );
          } catch (error) {
            logger.error(
              `[GracefulShutdown] Failed to mark job ${job.id} as failed:`,
              error,
            );
          }
        }
      }
    } catch (error) {
      logger.error(
        `[GracefulShutdown] Error checking incomplete jobs for ${workerName}:`,
        error,
      );
    }
  }

  // Step 4: Close all queues
  logger.info("[GracefulShutdown] Closing all queues");
  const closeQueuePromises = workerEntries
    .filter(([, config]) => config.queue)
    .map(async ([workerName, config]) => {
      try {
        await config.queue!.close();
        logger.info(`[GracefulShutdown] Closed queue for ${workerName}`);
      } catch (error) {
        logger.error(`[GracefulShutdown] Failed to close queue for ${workerName}:`, error);
      }
    });

  await Promise.allSettled(closeQueuePromises);

  logger.info("[GracefulShutdown] BullMQ worker graceful shutdown complete");
}

/**
 * Check if shutdown is in progress
 */
export function isShuttingDown(): boolean {
  return shutdownState.isShuttingDown;
}
