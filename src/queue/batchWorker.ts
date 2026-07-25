import { Worker, Job } from "bullmq";
import { queueOptions } from "./config";
import { BATCH_QUEUE_NAME, BATCH_CONCURRENCY, BatchJobItemData } from "./batchQueue";
import { batchJobStore } from "../services/batchJobStore";
import { WebSocketManager } from "../websocket/websocketManager";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { StellarService } from "../services/stellar/stellarService";
import { WebhookService, notifyTransactionWebhook } from "../services/webhook";
import logger from "../utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Worker
// ─────────────────────────────────────────────────────────────────────────────

const transactionModel = new TransactionModel();
const mobileMoneyService = new MobileMoneyService();
const webhookService = new WebhookService();

let stellarService: StellarService | null = null;
try {
  stellarService = new StellarService();
} catch {
  logger.warn("[BatchWorker] StellarService unavailable — deposits will be skipped");
}

/**
 * Process a single batch item:
 *  1. Create a transaction record
 *  2. Initiate mobile-money payment
 *  3. Send Stellar payment
 *  4. Update job progress atomically in Redis
 *  5. Broadcast progress via WebSocket
 */
async function processBatchItem(job: Job<BatchJobItemData>): Promise<void> {
  const { jobId, rowIndex, row, userId, total } = job.data;

  let transactionId: string | null = null;
  let succeeded = false;
  let errorDetail: { row: number; error: string } | undefined;

  try {
    // 1. Create transaction record
    const CORE_FIELDS = new Set(["amount", "phoneNumber", "provider", "stellarAddress"]);
    const metadata = Object.fromEntries(
      Object.entries(row).filter(([k]) => !CORE_FIELDS.has(k) && row[k] !== ""),
    );

    const transaction = await transactionModel.create({
      type: "deposit",
      amount: row.amount,
      phoneNumber: row.phoneNumber,
      provider: row.provider.toUpperCase(),
      stellarAddress: row.stellarAddress,
      status: TransactionStatus.Pending,
      tags: [jobId],
      metadata: { batchId: jobId, ...metadata },
    });
    transactionId = transaction.id;

    // 2. Initiate mobile-money payment
    await mobileMoneyService.initiatePayment(
      row.provider,
      row.phoneNumber,
      row.amount,
    );

    // 3. Send Stellar payment
    if (!stellarService) {
      await transactionModel.updateStatus(transactionId, TransactionStatus.Failed);
      await notifyTransactionWebhook(transactionId, "transaction.failed", {
        transactionModel,
        webhookService,
      });
      throw new Error("StellarService unavailable");
    }

    await stellarService.sendPayment(row.stellarAddress, row.amount);
    await transactionModel.updateStatus(transactionId, TransactionStatus.Completed);
    await notifyTransactionWebhook(transactionId, "transaction.completed", {
      transactionModel,
      webhookService,
    });

    succeeded = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, rowIndex, err }, "[BatchWorker] Row failed");

    if (transactionId) {
      await transactionModel
        .updateStatus(transactionId, TransactionStatus.Failed)
        .catch(() => undefined);
    }

    errorDetail = { row: rowIndex + 2, error: message };
  }

  // 4. Update Redis job state atomically
  await batchJobStore.incrementProgress(jobId, succeeded, errorDetail);

  // Check if all rows have been processed → mark complete
  const currentJob = await batchJobStore.get(jobId);
  if (currentJob && currentJob.processed >= total) {
    await batchJobStore.complete(jobId);
  }

  // 5. Broadcast progress to WebSocket subscribers
  broadcastBatchProgress(jobId, currentJob);
}

function broadcastBatchProgress(
  jobId: string,
  job: Awaited<ReturnType<typeof batchJobStore.get>>,
): void {
  try {
    const wsManager = WebSocketManager.getInstance();
    if (!wsManager || !job) return;

    wsManager.broadcastTransactionUpdate({
      id: jobId,
      status: job.status,
      type: "batch.progress",
      progress: {
        total: job.total,
        processed: job.processed,
        succeeded: job.succeeded,
        failed: job.failed,
      },
    });
  } catch (err) {
    logger.warn({ jobId, err }, "[BatchWorker] Failed to broadcast progress");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker instance
// ─────────────────────────────────────────────────────────────────────────────

export const batchWorker = new Worker<BatchJobItemData>(
  BATCH_QUEUE_NAME,
  processBatchItem,
  {
    ...queueOptions,
    concurrency: BATCH_CONCURRENCY,
  },
);

batchWorker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.data?.jobId, rowIndex: job?.data?.rowIndex, err },
    "[BatchWorker] Job failed (all retries exhausted)",
  );
});

batchWorker.on("error", (err) => {
  logger.error({ err }, "[BatchWorker] Worker error");
});

export async function closeBatchWorker(): Promise<void> {
  await batchWorker.close();
}
