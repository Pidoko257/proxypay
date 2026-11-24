import { Worker, Job, Queue } from "bullmq";
import { Redis } from "ioredis";
import sgMail from "@sendgrid/mail";
import { emailOutboxService } from "../services/emailOutboxService";
import logger from "../utils/logger";
import { LockManager } from "../utils/lock";

const EMAIL_OUTBOX_QUEUE_NAME = "email-outbox";

sgMail.setApiKey(process.env.SENDGRID_API_KEY || "");

let emailOutboxQueue: Queue | null = null;
let emailOutboxWorker: Worker | null = null;

/**
 * Initialize email outbox worker
 */
export async function startEmailOutboxWorker(redisClient: Redis) {
  if (emailOutboxWorker) {
    logger.warn("Email outbox worker already started");
    return;
  }

  emailOutboxQueue = new Queue(EMAIL_OUTBOX_QUEUE_NAME, {
    connection: {
      host: redisClient.options.host,
      port: redisClient.options.port,
      password: redisClient.options.password,
    },
    defaultJobOptions: {
      removeOnComplete: { age: 3600 }, // Keep completed jobs for 1 hour
      removeOnFail: { age: 86400 }, // Keep failed jobs for 24 hours
    },
  });

  emailOutboxWorker = new Worker(EMAIL_OUTBOX_QUEUE_NAME, processEmailBatch, {
    connection: {
      host: redisClient.options.host,
      port: redisClient.options.port,
      password: redisClient.options.password,
    },
    concurrency: 5,
  });

  emailOutboxWorker.on("completed", (job) => {
    logger.info({ jobId: job.id, jobName: job.name }, "Email batch job completed");
  });

  emailOutboxWorker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, jobName: job?.name, error: err.message },
      "Email batch job failed",
    );
  });

  logger.info("Email outbox worker started");
}

/**
 * Close email outbox worker
 */
export async function closeEmailOutboxWorker() {
  if (emailOutboxWorker) {
    await emailOutboxWorker.close();
    emailOutboxWorker = null;
  }
  if (emailOutboxQueue) {
    await emailOutboxQueue.close();
    emailOutboxQueue = null;
  }
}

/**
 * Schedule email batch processing job
 */
export async function scheduleEmailBatch(delayMs: number = 0) {
  if (!emailOutboxQueue) {
    throw new Error("Email outbox queue not initialized");
  }

  await emailOutboxQueue.add("process-batch", {}, {
    delay: delayMs,
    removeOnComplete: true,
  });
}

/**
 * Process a batch of pending emails
 */
async function processEmailBatch(job: Job) {
  logger.info("Starting email outbox batch processing");

  const batchSize = 50;
  const lockManager = new LockManager();
  let totalProcessed = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;

  try {
    // Get pending emails
    const pendingEmails = await emailOutboxService.getPendingEmails(batchSize);

    if (pendingEmails.length === 0) {
      logger.debug("No pending emails in outbox");
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    // Process each email
    for (const email of pendingEmails) {
      totalProcessed++;

      // Acquire lock to prevent duplicate processing
      const lockKey = `email-outbox:${email.id}`;
      const acquired = await lockManager.tryAcquire(lockKey, 30000);

      if (!acquired) {
        logger.debug({ emailId: email.id }, "Email already being processed");
        continue;
      }

      try {
        // Mark as processing
        await emailOutboxService.markProcessing(email.id);

        // Send email via SendGrid
        const sendResult = await sendEmailViaSendGrid(email);

        // Mark as delivered with provider info
        await emailOutboxService.markDelivered(email.id, {
          name: "sendgrid",
          messageId: sendResult.messageId,
          response: sendResult.fullResponse,
        });

        totalSucceeded++;
        logger.info(
          {
            emailId: email.id,
            recipient: maskEmail(email.recipient_email),
            type: email.email_type,
          },
          "Email delivered successfully",
        );
      } catch (sendError) {
        totalFailed++;

        const errorCode = getErrorCode(sendError);
        const errorMessage = getErrorMessage(sendError);

        logger.warn(
          {
            emailId: email.id,
            recipient: maskEmail(email.recipient_email),
            type: email.email_type,
            error: errorMessage,
            code: errorCode,
            attempt: email.attempts + 1,
            maxAttempts: email.max_attempts,
          },
          "Email delivery failed",
        );

        // Determine if this is retryable
        const isRetryable = isRetryableError(sendError, errorCode);

        if (isRetryable && email.attempts + 1 < email.max_attempts) {
          // Record failed attempt and schedule retry
          await emailOutboxService.recordFailedAttempt(email.id, {
            message: errorMessage,
            code: errorCode,
          });
        } else {
          // Move to DLQ
          const reason = isRetryable
            ? `Max attempts exhausted (${email.max_attempts})`
            : `Non-retryable error: ${errorCode}`;
          await emailOutboxService.moveToDLQ(email.id, reason);
        }
      } finally {
        await lockManager.release(lockKey);
      }

      // Rate limiting to avoid overwhelming SendGrid
      await sleep(100);
    }

    logger.info(
      { processed: totalProcessed, succeeded: totalSucceeded, failed: totalFailed },
      "Email batch processing completed",
    );

    return { processed: totalProcessed, succeeded: totalSucceeded, failed: totalFailed };
  } catch (error) {
    logger.error({ error }, "Email batch processing failed");
    throw error;
  }
}

/**
 * Send email via SendGrid
 */
async function sendEmailViaSendGrid(email: any): Promise<{ messageId: string; fullResponse: any }> {
  const message: any = {
    from: process.env.EMAIL_FROM || '"ProxyPay" <no-reply@proxypay.io>',
    to: email.recipient_email,
    subject: email.subject,
    html: email.body_html,
    text: email.body_text,
  };

  // Add custom headers if provided
  if (email.headers) {
    message.headers = email.headers;
  }

  // Validate message
  if (!message.html && !message.text) {
    throw new Error("Email must have body_html or body_text");
  }

  const response = await sgMail.send(message);

  // Extract message ID from SendGrid response headers
  const messageId = response[0]?.headers?.["x-message-id"] || `sendgrid-${Date.now()}`;

  return {
    messageId,
    fullResponse: {
      statusCode: response[0].statusCode,
      headers: response[0].headers,
    },
  };
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: any, errorCode?: string): boolean {
  // SendGrid-specific error handling
  if (error.response?.status) {
    const status = error.response.status;

    // Retryable status codes
    if ([408, 429, 500, 502, 503, 504].includes(status)) {
      return true;
    }

    // Non-retryable status codes
    if ([400, 401, 403, 404, 413].includes(status)) {
      return false;
    }
  }

  // Default to retryable for transient network errors
  const message = error.message?.toLowerCase() || "";
  if (message.includes("econnrefused") || message.includes("timeout") || message.includes("enotfound")) {
    return true;
  }

  return false;
}

/**
 * Get error code from SendGrid response or error
 */
function getErrorCode(error: any): string {
  if (error.response?.status) {
    return `http_${error.response.status}`;
  }

  if (error.code) {
    return error.code;
  }

  if (error.message?.includes("401")) return "http_401";
  if (error.message?.includes("429")) return "http_429";
  if (error.message?.includes("500")) return "http_500";
  if (error.message?.includes("timeout")) return "timeout";

  return "unknown";
}

/**
 * Get error message from SendGrid response or error
 */
function getErrorMessage(error: any): string {
  if (error.response?.body?.errors) {
    return error.response.body.errors[0]?.message || "SendGrid error";
  }

  return error.message || "Unknown error";
}

/**
 * Mask email for logging
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || local.length <= 2) return `***@${domain}`;
  return `${local[0]}${"*".repeat(Math.max(0, local.length - 2))}${local[local.length - 1]}@${domain}`;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { EMAIL_OUTBOX_QUEUE_NAME };
