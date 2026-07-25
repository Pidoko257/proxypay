import { Queue, Job } from "bullmq";
import { queueOptions } from "./config";
import { CsvRow } from "../routes/bulk";

export const BATCH_QUEUE_NAME = "batch-transactions";

/**
 * Configurable batch size: how many rows are loaded into memory per upload.
 * Individual queue items are always one row, but the initial slice size for
 * splitting large uploads can be controlled with this env var.
 */
export const BATCH_TRANSACTION_SIZE = Math.max(
  1,
  parseInt(process.env.BATCH_TRANSACTION_SIZE || "50", 10),
);

/**
 * How many batch queue jobs may be processed concurrently by the worker.
 */
export const BATCH_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.BATCH_CONCURRENCY || "10", 10),
);

/**
 * The data payload for a single item in the batch queue.
 */
export interface BatchJobItemData {
  /** The parent batch job ID */
  jobId: string;
  /** Zero-based index of this row in the original CSV */
  rowIndex: number;
  /** The parsed CSV row data */
  row: CsvRow;
  /** ID of the user who submitted the bulk upload */
  userId: string;
  /** Total number of items in the parent batch (for progress calculations) */
  total: number;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  isPaused: boolean;
}

// The BullMQ queue for individual batch transaction items
export const batchQueue = new Queue<BatchJobItemData>(BATCH_QUEUE_NAME, {
  ...queueOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000, // 2s → 4s → 8s
    },
    // Remove completed jobs after 1 hour to keep Redis lean
    removeOnComplete: { age: 3600 },
    // Keep failed jobs for 24 hours for debugging
    removeOnFail: { age: 86400 },
  },
});

/**
 * Enqueue a single batch item for processing.
 */
export async function addBatchJob(data: BatchJobItemData): Promise<Job<BatchJobItemData>> {
  const jobId = `${data.jobId}:row:${data.rowIndex}`;
  return batchQueue.add("process-batch-item", data, { jobId });
}

/**
 * Enqueue multiple batch items for processing in bulk.
 * More efficient than calling addBatchJob in a loop.
 */
export async function addBatchJobs(items: BatchJobItemData[]): Promise<void> {
  if (items.length === 0) return;

  const bulkJobs = items.map((data) => ({
    name: "process-batch-item",
    data,
    opts: { jobId: `${data.jobId}:row:${data.rowIndex}` },
  }));

  await batchQueue.addBulk(bulkJobs);
}

/**
 * Get current queue health statistics.
 */
export async function getBatchQueueStats(): Promise<QueueStats> {
  const [waiting, active, completed, failed, isPaused] = await Promise.all([
    batchQueue.getWaitingCount(),
    batchQueue.getActiveCount(),
    batchQueue.getCompletedCount(),
    batchQueue.getFailedCount(),
    batchQueue.isPaused(),
  ]);

  return { waiting, active, completed, failed, isPaused };
}

/**
 * Cancel all jobs belonging to a given batch job ID.
 * Jobs that are already active cannot be cancelled.
 */
export async function cancelBatchJobs(jobId: string): Promise<number> {
  const waiting = await batchQueue.getWaiting();
  let cancelled = 0;

  for (const job of waiting) {
    if (job.data.jobId === jobId) {
      await job.remove();
      cancelled++;
    }
  }

  return cancelled;
}
