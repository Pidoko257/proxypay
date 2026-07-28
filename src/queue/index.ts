import { rabbitMQManager } from "./rabbitmq";
import { transactionQueue } from "./transactionQueue";
import { transactionWorker, closeWorker } from "./worker";
import { syncQueue } from "./syncQueue";
import { syncWorker, closeSyncWorker } from "./syncWorker";
import { connection } from "./config";
import { startProviderBalanceAlertWorker, closeProviderBalanceAlertWorker } from "./providerBalanceAlertWorker";
import { scheduleProviderBalanceAlertJob } from "./providerBalanceAlertQueue";
import { startAccountingTokenRefreshWorker, closeAccountingTokenRefreshWorker } from "./accountingTokenRefreshWorker";
import { handleBullMQGracefulShutdown } from "./gracefulShutdown";
import { closeAccountMergeWorker } from "./accountMergeWorker";

export async function shutdownQueue(): Promise<void> {
  // Handle BullMQ worker graceful shutdown with proper timeout and job completion
  await handleBullMQGracefulShutdown();

  // Close other queue resources
  await Promise.all([
    closeWorker().catch(() => undefined),
    closeSyncWorker().catch(() => undefined),
    closeAccountingTokenRefreshWorker().catch(() => undefined),
    closeProviderBalanceAlertWorker().catch(() => undefined),
    closeAccountMergeWorker().catch(() => undefined),
    transactionQueue.close().catch(() => undefined),
    syncQueue.close().catch(() => undefined),
  ]);
}

export {
  transactionQueue,
  addTransactionJob,
  getJobById,
  getJobProgress,
  getQueueStats,
  pauseQueue,
  resumeQueue,
  drainQueue,
} from "./transactionQueue";
export type {
  TransactionJobData,
  TransactionJobResult,
} from "./transactionQueue";

export {
  syncQueue,
  addSyncJob,
  getSyncJobById,
  getSyncQueueStats,
} from "./syncQueue";
export type { SyncJobData, SyncJobResult } from "./syncQueue";

export { transactionWorker, closeWorker };
export { syncWorker, closeSyncWorker };
export { createQueueDashboard } from "./dashboard";
export {
  getQueueHealth,
  pauseQueueEndpoint,
  resumeQueueEndpoint,
} from "./health";
export {
  getQueueStatsAggregate,
  queueDepthHandler,
  queueDepthPrometheusHandler,
} from "./queueDepthMetrics";

export { queueOptions } from "./config";
export { capturePersistentFailure, queryDLQ, replayDLQEntry } from "./dlq";
export type { DLQEntry, CaptureOptions, DLQQueryOptions } from "./dlq";
export { startProviderBalanceAlertWorker, scheduleProviderBalanceAlertJob };

// Account Merge Queue Exports
export {
  accountMergeQueue,
  addAccountMergeJob,
  addBatchAccountMergeJobs,
  getAccountMergeJobById,
  getAccountMergeQueueStats,
  pauseAccountMergeQueue,
  resumeAccountMergeQueue,
  drainAccountMergeQueue,
  closeAccountMergeQueue,
} from "./accountMergeQueue";
export type {
  AccountMergeJobData,
  AccountMergeJobResult,
} from "./accountMergeQueue";
export {
  accountMergeWorker,
  closeAccountMergeWorker,
} from "./accountMergeWorker";

export {
  startAccountingTokenRefreshWorker,
  closeAccountingTokenRefreshWorker,
};

// Trace-ID propagation utilities
export { withTraceId, traceIdFromJob, childLoggerWithTrace, TRACE_ID_KEY } from "./trace";
