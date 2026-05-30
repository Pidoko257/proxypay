import { Worker, Job } from "bullmq";
import { queueOptions } from "./config";
import { ACCOUNTING_TOKEN_REFRESH_QUEUE_NAME, AccountingTokenRefreshJobData } from "./accountingTokenRefreshQueue";
import { AccountingService } from "../services/accounting";
import { logger } from "../services/logger";

let worker: Worker | null = null;

export function startAccountingTokenRefreshWorker(): void {
  if (worker) return;

  const accountingService = new AccountingService();

  worker = new Worker(
    ACCOUNTING_TOKEN_REFRESH_QUEUE_NAME,
    async (job: Job<AccountingTokenRefreshJobData>) => {
      const { connectionId, provider } = job.data;
      
      logger.info(`Processing token refresh for ${provider} connection ${connectionId}`);
      
      try {
        if (provider === "quickbooks") {
          await accountingService.refreshQuickBooksToken(connectionId);
        } else if (provider === "xero") {
          await accountingService.refreshXeroToken(connectionId);
        } else {
          throw new Error(`Unsupported accounting provider: ${provider}`);
        }
        
        logger.info(`Successfully refreshed tokens for ${provider} connection ${connectionId}`);
      } catch (error) {
        logger.error(`Failed to refresh tokens for ${provider} connection ${connectionId}:`, error);
        throw error; // Re-throw to trigger BullMQ retry
      }
    },
    queueOptions
  );

  worker.on("failed", (job, err) => {
    logger.error(`Accounting token refresh job ${job?.id} failed:`, err);
  });

  logger.info("Accounting token refresh worker started");
}

export async function closeAccountingTokenRefreshWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("Accounting token refresh worker closed");
  }
}
