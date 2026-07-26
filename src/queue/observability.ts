import { Queue } from "bullmq";
import { syncQueue, SYNC_QUEUE_NAME } from "./syncQueue";
import { accountMergeQueue, ACCOUNT_MERGE_QUEUE_NAME } from "./accountMergeQueue";
import {
  providerBalanceAlertQueue,
  PROVIDER_BALANCE_ALERT_QUEUE_NAME,
} from "./providerBalanceAlertQueue";
import {
  accountingTokenRefreshQueue,
  ACCOUNTING_TOKEN_REFRESH_QUEUE_NAME,
} from "./accountingTokenRefreshQueue";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

/** Maximum number of failed jobs returned per queue by the observability endpoint. */
export const MAX_FAILED_JOBS = 10;

/**
 * Registry of every real BullMQ queue in the system, keyed by queue name.
 * `transactionQueue` is intentionally excluded: it has been migrated to
 * RabbitMQ and no longer exposes BullMQ's job-counts/getFailed API.
 */
const queueRegistry: Record<string, Queue> = {
  [SYNC_QUEUE_NAME]: syncQueue,
  [ACCOUNT_MERGE_QUEUE_NAME]: accountMergeQueue,
  [PROVIDER_BALANCE_ALERT_QUEUE_NAME]: providerBalanceAlertQueue,
  [ACCOUNTING_TOKEN_REFRESH_QUEUE_NAME]: accountingTokenRefreshQueue,
};

export interface QueueMetrics {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface FailedJobDetail {
  id: string;
  name: string;
  failedReason: string;
  stacktrace: string[];
  attemptsMade: number;
  timestamp: number | null;
  failedAt: number | null;
}

export function getMonitoredQueueNames(): string[] {
  return Object.keys(queueRegistry);
}

function getQueueByName(name: string): Queue {
  const queue = queueRegistry[name];
  if (!queue) {
    throw createError(ERROR_CODES.NOT_FOUND, `Queue "${name}" not found`, {
      availableQueues: getMonitoredQueueNames(),
    });
  }
  return queue;
}

async function getQueueMetrics(name: string, queue: Queue): Promise<QueueMetrics> {
  const counts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
  return {
    name,
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
  };
}

/**
 * Aggregate waiting/active/completed/failed/delayed counts for every
 * BullMQ queue in the system. Powers GET /api/admin/queues.
 */
export async function getAllQueueMetrics(): Promise<QueueMetrics[]> {
  return Promise.all(
    Object.entries(queueRegistry).map(([name, queue]) => getQueueMetrics(name, queue)),
  );
}

/**
 * Returns the most recent failed jobs (default/most recent-first, capped at
 * MAX_FAILED_JOBS) for a single named queue, with error details. Throws a
 * NOT_FOUND AppError if the queue name isn't recognized.
 *
 * Job payload data is intentionally omitted: some queues (e.g. account
 * merges) carry sensitive fields such as Stellar secret keys, which must
 * never be surfaced through an observability endpoint.
 */
export async function getQueueFailedJobs(
  name: string,
  limit: number = MAX_FAILED_JOBS,
): Promise<FailedJobDetail[]> {
  const queue = getQueueByName(name);
  const boundedLimit = Math.min(Math.max(Math.trunc(limit) || MAX_FAILED_JOBS, 1), MAX_FAILED_JOBS);

  // Over-fetch and sort explicitly by finish time so the result is reliably
  // "most recent first" regardless of BullMQ's underlying sorted-set order.
  const jobs = await queue.getFailed(0, Math.max(boundedLimit * 3, 30));

  return jobs
    .map((job) => ({
      id: job.id ?? "",
      name: job.name,
      failedReason: job.failedReason || "Unknown error",
      stacktrace: job.stacktrace ?? [],
      attemptsMade: job.attemptsMade ?? 0,
      timestamp: job.timestamp ?? null,
      failedAt: job.finishedOn ?? null,
    }))
    .sort((a, b) => (b.failedAt ?? b.timestamp ?? 0) - (a.failedAt ?? a.timestamp ?? 0))
    .slice(0, boundedLimit);
}
