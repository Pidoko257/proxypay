import { Router, Request, Response, NextFunction } from "express";
import { authenticateToken } from "../middleware/auth";
import multer, { MulterError } from "multer";
import csvParser from "csv-parser";
import { Readable } from "stream";

import { TransactionModel, TransactionStatus } from "../models/transaction";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { StellarService } from "../services/stellar/stellarService";
import { notifyTransactionWebhook, WebhookService } from "../services/webhook";
import { checkAccountStatusStrict } from "../middleware/checkAccountStatus";
import highThroughputService, {
  PaymentOptions,
} from "../services/stellar/highThroughputService";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";
import { batchJobStore, BatchJob } from "../services/batchJobStore";
import { addBatchJobs, BATCH_TRANSACTION_SIZE, cancelBatchJobs } from "../queue/batchQueue";
import { pool } from "../config/database";

export interface CsvRow {
  amount: string;
  phoneNumber: string;
  provider: string;
  stellarAddress: string;
  [key: string]: string;
}

interface ValidationError {
  row: number;
  field: string;
  message: string;
}

type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface BulkJob {
  id: string;
  status: JobStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ row: number; error: string }>;
  createdAt: Date;
  completedAt?: Date;
}

const jobs = new Map<string, BulkJob>();

export function getBulkImportJob(jobId: string): BulkJob | undefined {
  return jobs.get(jobId);
}

const SUPPORTED_PROVIDERS = ["MTN", "AIRTEL", "ORANGE"];
const PHONE_REGEX = /^\+\d{7,15}$/;
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

function validateRow(row: CsvRow, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const rowNum = index + 2;

  if (!row.amount || isNaN(Number(row.amount)) || Number(row.amount) <= 0) {
    errors.push({
      row: rowNum,
      field: "amount",
      message: "Must be a positive number",
    });
  }

  if (!row.phoneNumber || !PHONE_REGEX.test(row.phoneNumber.trim())) {
    errors.push({
      row: rowNum,
      field: "phoneNumber",
      message: "Must be a valid E.164 phone number (e.g. +237670000000)",
    });
  }

  if (
    !row.provider ||
    !SUPPORTED_PROVIDERS.includes(row.provider.trim().toUpperCase())
  ) {
    errors.push({
      row: rowNum,
      field: "provider",
      message: `Must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
    });
  }

  if (
    !row.stellarAddress ||
    !STELLAR_ADDRESS_REGEX.test(row.stellarAddress.trim())
  ) {
    errors.push({
      row: rowNum,
      field: "stellarAddress",
      message:
        "Must be a valid Stellar public key (56 characters, starting with G)",
    });
  }

  return errors;
}

function parseCsv(buffer: Buffer): Promise<CsvRow[]> {
  return new Promise((resolve, reject) => {
    const rows: CsvRow[] = [];
    Readable.from(buffer.toString("utf-8"))
      .pipe(
        csvParser({
          mapHeaders: ({ header }) => header.trim(),
          mapValues: ({ value }) => value.trim(),
        }),
      )
      .on("data", (row: CsvRow) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

async function processJob(jobId: string, rows: CsvRow[]): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  job.status = "processing";

  try {
    const transactionModel = new TransactionModel();
    const mobileMoneyService = new MobileMoneyService();
    const webhookService = new WebhookService();

    let stellarService: StellarService | null = null;
    try {
      stellarService = new StellarService();
    } catch {
      console.warn(
        "[BulkImport] StellarService unavailable - deposits will be skipped",
      );
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let transactionId: string | null = null;
      let failedAlreadyHandled = false;

      try {
        const CORE_FIELDS = new Set([
          "amount",
          "phoneNumber",
          "provider",
          "stellarAddress",
        ]);
        const metadata = Object.fromEntries(
          Object.entries(row).filter(
            ([k]) => !CORE_FIELDS.has(k) && row[k] !== "",
          ),
        );
        const transaction = await transactionModel.create({
          type: "deposit",
          amount: row.amount,
          phoneNumber: row.phoneNumber,
          provider: row.provider.toUpperCase(),
          stellarAddress: row.stellarAddress,
          status: TransactionStatus.Pending,
          tags: [jobId],
          metadata: { batchId: jobId },
        });
        transactionId = transaction.id;

        await mobileMoneyService.initiatePayment(
          row.provider,
          row.phoneNumber,
          row.amount,
        );

        if (!stellarService) {
          await transactionModel.updateStatus(
            transaction.id,
            TransactionStatus.Failed,
          );
          await notifyTransactionWebhook(transaction.id, "transaction.failed", {
            transactionModel,
            webhookService,
          });
          failedAlreadyHandled = true;
          throw new Error("StellarService unavailable - deposit not completed");
        }

        await stellarService.sendPayment(row.stellarAddress, row.amount);
        await transactionModel.updateStatus(
          transaction.id,
          TransactionStatus.Completed,
        );
        await notifyTransactionWebhook(
          transaction.id,
          "transaction.completed",
          {
            transactionModel,
            webhookService,
          },
        );

        job.succeeded++;
      } catch (error) {
        if (transactionId && !failedAlreadyHandled) {
          await transactionModel.updateStatus(
            transactionId,
            TransactionStatus.Failed,
          );
          await notifyTransactionWebhook(transactionId, "transaction.failed", {
            transactionModel,
            webhookService,
          });
        }

        job.failed++;
        job.errors.push({
          row: i + 2,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        job.processed++;
      }
    }
  } catch (error) {
    console.error("[BulkImport] Fatal error in processJob:", error);
  } finally {
    job.status = "completed";
    job.completedAt = new Date();
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isCsv =
      file.mimetype === "text/csv" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.originalname.toLowerCase().endsWith(".csv");

    if (isCsv) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are accepted"));
    }
  },
});

export const bulkRoutes = Router();

bulkRoutes.post(
  "/",
  authenticateToken,
  checkAccountStatusStrict,
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        'Send a CSV file using multipart/form-data with field name "file"',
        { error: "No file uploaded" },
      );
    }

    let rows: CsvRow[];
    try {
      rows = await parseCsv(req.file.buffer);
    } catch (err) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        err instanceof Error ? err.message : "Unknown parse error",
        { error: "Failed to parse CSV" },
      );
    }

    if (rows.length === 0) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "CSV file contains no data rows",
        { error: "CSV file contains no data rows" },
      );
    }

    const validationErrors: ValidationError[] = [];
    rows.forEach((row, index) => {
      validationErrors.push(...validateRow(row, index));
    });

    if (validationErrors.length > 0) {
      throw createError(
        ERROR_CODES.UNPROCESSABLE_CONTENT,
        "CSV validation failed - no transactions were processed",
        { error: "CSV validation failed - no transactions were processed" },
      );
    }

    const jobId = crypto.randomUUID();
    const userId = (req as any).user?.id ?? "anonymous";
    const batchSize = Math.min(
      parseInt(String(req.query.batchSize ?? BATCH_TRANSACTION_SIZE), 10) || BATCH_TRANSACTION_SIZE,
      500,
    );

    // Create job in Redis-backed store (falls back gracefully if Redis is down)
    const batchJob: BatchJob = {
      id: jobId,
      status: "pending",
      total: rows.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: [],
      createdAt: new Date(),
      userId,
      batchSize,
    };
    await batchJobStore.create(batchJob);

    // Also keep in-memory for fallback / backward compatibility
    const legacyJob: BulkJob = { ...batchJob };
    jobs.set(jobId, legacyJob);

    // Enqueue individual rows into BullMQ batch queue
    try {
      await addBatchJobs(
        rows.map((row, i) => ({ jobId, rowIndex: i, row, userId, total: rows.length })),
      );
    } catch {
      // If BullMQ is unavailable, fall back to in-process execution
      setImmediate(() => processJob(jobId, rows));
    }

    return res.status(202).json({
      jobId,
      message: `Bulk import queued - ${rows.length} transaction(s) will be processed`,
      statusUrl: `/api/transactions/bulk/${jobId}`,
    });
  },
);

bulkRoutes.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(413)
        .json({ error: "File too large - maximum size is 10 MB" });
    }

    if (err instanceof Error) {
      throw createError(ERROR_CODES.INVALID_INPUT, err.message, {
        error: err.message,
      });
    }

    next(err);
  },
);

bulkRoutes.get("/:jobId", async (req: Request, res: Response) => {
  // Try Redis-backed store first, fall back to in-memory map
  const redisJob = await batchJobStore.get(req.params.jobId);
  const job = redisJob ?? jobs.get(req.params.jobId);

  if (!job) {
    throw createError(ERROR_CODES.NOT_FOUND, "Job not found", {
      error: "Job not found",
    });
  }

  return res.json({
    jobId: job.id,
    status: job.status,
    progress: {
      total: job.total,
      processed: job.processed,
      succeeded: job.succeeded,
      failed: job.failed,
    },
    errors: job.errors,
    createdAt: job.createdAt,
    ...(job.completedAt && { completedAt: job.completedAt }),
    ...("batchSize" in job && { batchSize: (job as BatchJob).batchSize }),
    ...("exportUrl" in job && (job as BatchJob).exportUrl && { exportUrl: (job as BatchJob).exportUrl }),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list batch jobs for the authenticated user
// ─────────────────────────────────────────────────────────────────────────────
bulkRoutes.get(
  "/",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = (req as any).user?.id;
    if (!userId) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required");
    }

    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
    const jobs = await batchJobStore.listByUser(userId, limit);

    return res.json({
      jobs: jobs.map((j) => ({
        jobId: j.id,
        status: j.status,
        total: j.total,
        processed: j.processed,
        succeeded: j.succeeded,
        failed: j.failed,
        createdAt: j.createdAt,
        ...(j.completedAt && { completedAt: j.completedAt }),
        ...(j.exportUrl && { exportUrl: j.exportUrl }),
      })),
      count: jobs.length,
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:jobId — cancel a pending batch job
// ─────────────────────────────────────────────────────────────────────────────
bulkRoutes.delete(
  "/:jobId",
  authenticateToken,
  async (req: Request, res: Response) => {
    const { jobId } = req.params;
    const userId = (req as any).user?.id;

    const job = await batchJobStore.get(jobId);
    if (!job) {
      throw createError(ERROR_CODES.NOT_FOUND, "Job not found");
    }

    // Only the owning user (or admin) can cancel
    if (job.userId !== userId) {
      throw createError(ERROR_CODES.FORBIDDEN, "Not authorized to cancel this job");
    }

    if (job.status !== "pending") {
      return res.status(409).json({ error: "Only pending jobs can be cancelled" });
    }

    const cancelled = await cancelBatchJobs(jobId);
    await batchJobStore.delete(jobId);

    return res.json({ message: "Job cancelled", rowsCancelled: cancelled });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /:jobId/export — download batch results as CSV or JSON
// ─────────────────────────────────────────────────────────────────────────────
bulkRoutes.get(
  "/:jobId/export",
  authenticateToken,
  async (req: Request, res: Response) => {
    const { jobId } = req.params;
    const format = String(req.query.format ?? "json").toLowerCase();

    const job = await batchJobStore.get(jobId) ?? jobs.get(jobId);
    if (!job) {
      throw createError(ERROR_CODES.NOT_FOUND, "Job not found");
    }

    if (job.status !== "completed") {
      return res.status(409).json({ error: "Export is only available for completed jobs" });
    }

    // Fetch the actual transaction records tagged with this batchId
    const { rows: txRows } = await pool.query(
      `SELECT id, reference_number, type, amount, phone_number, provider,
              status, stellar_address, created_at, updated_at
       FROM transactions
       WHERE metadata->>'batchId' = $1
       ORDER BY created_at ASC`,
      [jobId],
    );

    if (format === "csv") {
      const header = "id,reference_number,type,amount,phone_number,provider,status,stellar_address,created_at\n";
      const csvBody = txRows
        .map((r: any) =>
          [
            r.id,
            r.reference_number,
            r.type,
            r.amount,
            r.phone_number,
            r.provider,
            r.status,
            r.stellar_address,
            new Date(r.created_at).toISOString(),
          ]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`)
            .join(","),
        )
        .join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="batch-${jobId}.csv"`);
      return res.send(header + csvBody);
    }

    // Default: JSON
    return res.json({
      jobId,
      status: job.status,
      summary: {
        total: job.total,
        succeeded: job.succeeded,
        failed: job.failed,
      },
      transactions: txRows,
      exportedAt: new Date().toISOString(),
    });
  },
);
