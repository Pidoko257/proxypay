import { Request, Response, Router } from "express";
import QueryStream from "pg-query-stream";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { pool } from "../config/database";
import { requireAuth } from "../middleware/auth";
import { TransactionStatus } from "../models/transaction";

type QueryValue = string | string[] | undefined;

export interface TransactionExportFilters {
  status?: TransactionStatus;
  provider?: string;
  type?: "deposit" | "withdraw";
  phoneNumber?: string;
  stellarAddress?: string;
  referenceNumber?: string;
  userId?: string;
  from?: Date;
  to?: Date;
  minAmount?: number;
  maxAmount?: number;
  tags?: string[];
}

type QueryStreamFactory = (text: string, values: unknown[]) => unknown;

interface QueryableClient {
  query(query: unknown): Readable;
  release(): void;
}

interface PoolLike {
  connect(): Promise<QueryableClient>;
}

interface ExportRouteDependencies {
  db?: PoolLike;
  createQueryStream?: QueryStreamFactory;
}

const CSV_HEADERS = [
  "ID",
  "Reference Number",
  "Type",
  "Amount",
  "Phone Number",
  "Provider",
  "Status",
  "Stellar Address",
  "Tags",
  "Notes",
  "Admin Notes",
  "User ID",
  "Created At",
  "Updated At",
];

function singleQueryValue(value: QueryValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseDate(value: string, label: string, endOfDay = false): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(
    dateOnly
      ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
      : value,
  );

  if (
    Number.isNaN(date.getTime()) ||
    (dateOnly && !date.toISOString().startsWith(value))
  ) {
    throw new Error(`Invalid ${label} date`);
  }

  return date;
}

function parseOptionalAmount(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    throw new Error(`Invalid ${label}`);
  }

  return amount;
}

export function parseTransactionExportFilters(
  query: Request["query"],
): TransactionExportFilters {
  const status = singleQueryValue(query.status as QueryValue);
  const provider = singleQueryValue(query.provider as QueryValue);
  const type = singleQueryValue(query.type as QueryValue);
  const phoneNumber =
    singleQueryValue(query.phoneNumber as QueryValue) ??
    singleQueryValue(query.phone as QueryValue);
  const stellarAddress = singleQueryValue(query.stellarAddress as QueryValue);
  const referenceNumber = singleQueryValue(query.referenceNumber as QueryValue);
  const userId = singleQueryValue(query.userId as QueryValue);
  const from =
    singleQueryValue(query.startDate as QueryValue) ??
    singleQueryValue(query.from as QueryValue);
  const to =
    singleQueryValue(query.endDate as QueryValue) ??
    singleQueryValue(query.to as QueryValue);
  const minAmount = parseOptionalAmount(
    singleQueryValue(query.minAmount as QueryValue),
    "minAmount",
  );
  const maxAmount = parseOptionalAmount(
    singleQueryValue(query.maxAmount as QueryValue),
    "maxAmount",
  );
  const tags = singleQueryValue(query.tags as QueryValue);

  if (
    status &&
    !Object.values(TransactionStatus).includes(status as TransactionStatus)
  ) {
    throw new Error(
      `Invalid status. Expected one of: ${Object.values(TransactionStatus).join(", ")}`,
    );
  }

  if (type && type !== "deposit" && type !== "withdraw") {
    throw new Error("Invalid type. Expected one of: deposit, withdraw");
  }

  const parsedFrom = from ? parseDate(from, "startDate") : undefined;
  const parsedTo = to ? parseDate(to, "endDate", true) : undefined;

  if (parsedFrom && parsedTo && parsedFrom > parsedTo) {
    throw new Error("startDate cannot be greater than endDate");
  }

  if (
    minAmount !== undefined &&
    maxAmount !== undefined &&
    minAmount > maxAmount
  ) {
    throw new Error("minAmount cannot be greater than maxAmount");
  }

  const filters: TransactionExportFilters = {
    from: parsedFrom,
    to: parsedTo,
    minAmount,
    maxAmount,
  };

  if (status) filters.status = status as TransactionStatus;
  if (provider) filters.provider = provider;
  if (type) filters.type = type as "deposit" | "withdraw";
  if (phoneNumber) filters.phoneNumber = phoneNumber;
  if (stellarAddress) filters.stellarAddress = stellarAddress;
  if (referenceNumber) filters.referenceNumber = referenceNumber;
  if (userId) filters.userId = userId;
  if (tags) {
    filters.tags = tags
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
  }

  return filters;
}

export function buildTransactionExportQuery(
  filters: TransactionExportFilters,
): {
  text: string;
  values: unknown[];
} {
  const whereClauses: string[] = [];
  const values: unknown[] = [];

  const addClause = (
    clauseFactory: (index: number) => string,
    value: unknown,
  ) => {
    values.push(value);
    whereClauses.push(clauseFactory(values.length));
  };

  if (filters.status) addClause((i) => `status = $${i}`, filters.status);
  if (filters.provider) addClause((i) => `provider = $${i}`, filters.provider);
  if (filters.type) addClause((i) => `type = $${i}`, filters.type);
  if (filters.phoneNumber) {
    addClause((i) => `phone_number = $${i}`, filters.phoneNumber);
  }
  if (filters.stellarAddress) {
    addClause((i) => `stellar_address = $${i}`, filters.stellarAddress);
  }
  if (filters.referenceNumber) {
    addClause((i) => `reference_number = $${i}`, filters.referenceNumber);
  }
  if (filters.from) addClause((i) => `created_at >= $${i}`, filters.from);
  if (filters.to) addClause((i) => `created_at <= $${i}`, filters.to);
  if (filters.tags?.length) {
    addClause((i) => `tags @> $${i}::text[]`, filters.tags);
  }
  if (filters.minAmount !== undefined) {
    addClause((i) => `amount >= $${i}`, filters.minAmount);
  }
  if (filters.maxAmount !== undefined) {
    addClause((i) => `amount <= $${i}`, filters.maxAmount);
  }
  if (filters.userId) addClause((i) => `user_id = $${i}`, filters.userId);

  const whereSql =
    whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";

  return {
    text:
      `SELECT id, reference_number, type, amount, phone_number, provider, status, ` +
      `stellar_address, tags, notes, admin_notes, user_id, created_at, updated_at ` +
      `FROM transactions${whereSql} ORDER BY created_at DESC, id DESC`,
    values,
  };
}

function formatReadableDate(value: unknown): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;

  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }

  const pad = (part: number) => String(part).padStart(2, "0");
  const datePart = [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join("-");
  const timePart = [
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join(":");

  return `${datePart} ${timePart}`;
}

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const raw = Array.isArray(value)
    ? value.map((item) => String(item)).join("|")
    : String(value);
  const escaped = raw.replace(/"/g, '""');

  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function transactionRowToCsv(row: Record<string, unknown>): string {
  const fields = [
    row.id,
    row.reference_number,
    row.type,
    row.amount,
    row.phone_number,
    row.provider,
    row.status,
    row.stellar_address,
    row.tags,
    row.notes,
    row.admin_notes,
    row.user_id,
    formatReadableDate(row.created_at),
    formatReadableDate(row.updated_at),
  ];

  return `${fields.map(escapeCsvValue).join(",")}\n`;
}

function createCsvTransform(): Transform {
  let wroteHeader = false;
  const header = `${CSV_HEADERS.join(",")}\n`;

  return new Transform({
    writableObjectMode: true,
    transform(row: Record<string, unknown>, _encoding, callback) {
      const prefix = wroteHeader ? "" : header;
      wroteHeader = true;
      callback(null, `${prefix}${transactionRowToCsv(row)}`);
    },
    flush(callback) {
      if (!wroteHeader) {
        this.push(header);
      }
      callback();
    },
  });
}

function createJsonTransform(): Transform {
  let first = true;

  return new Transform({
    writableObjectMode: true,
    transform(row: Record<string, unknown>, _encoding, callback) {
      const prefix = first ? "[\n" : ",\n";
      first = false;
      callback(null, `${prefix}${JSON.stringify(row)}`);
    },
    flush(callback) {
      this.push(first ? "[]\n" : "\n]\n");
      callback();
    },
  });
}

function defaultQueryStreamFactory(text: string, values: unknown[]): unknown {
  return new QueryStream(text, values, { batchSize: 250 });
}

function isExpectedDisconnect(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return (
    error.name === "AbortError" ||
    code === "ABORT_ERR" ||
    code === "ERR_STREAM_PREMATURE_CLOSE"
  );
}

export function createExportRoutes(
  dependencies: ExportRouteDependencies = {},
): Router {
  const router = Router();
  const db = dependencies.db ?? (pool as unknown as PoolLike);
  const createQueryStream =
    dependencies.createQueryStream ?? defaultQueryStreamFactory;

  router.get("/export", requireAuth, async (req: Request, res: Response) => {
    let client: QueryableClient | null = null;
    let rowStream: Readable | null = null;
    let released = false;
    let disconnected = false;
    const abortController = new AbortController();

    const releaseClient = () => {
      if (client && !released) {
        released = true;
        client.release();
      }
    };

    const abortExport = () => {
      if (res.writableFinished || disconnected) {
        return;
      }

      disconnected = true;
      abortController.abort();
      rowStream?.destroy();
    };

    req.once("aborted", abortExport);
    res.once("close", abortExport);

    try {
      const filters = parseTransactionExportFilters(req.query);
      const { text, values } = buildTransactionExportQuery(filters);

      client = await db.connect();

      if (disconnected) {
        return;
      }

      const queryStream = createQueryStream(text, values);
      rowStream = client.query(queryStream);

      const json = singleQueryValue(req.query.format as QueryValue) === "json";
      const extension = json ? "json" : "csv";
      const filename = `transactions-${new Date().toISOString().slice(0, 10)}.${extension}`;

      res.status(200);
      res.setHeader(
        "Content-Type",
        json ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.setHeader("Cache-Control", "no-store");

      await pipeline(
        rowStream,
        json ? createJsonTransform() : createCsvTransform(),
        res,
        { signal: abortController.signal },
      );
    } catch (error) {
      if (!disconnected && !isExpectedDisconnect(error)) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to export transactions";
        const statusCode =
          message.startsWith("Invalid") ||
          message.includes("cannot be greater than")
            ? 400
            : 500;

        if (!res.headersSent) {
          res.status(statusCode).json({ error: message });
        } else {
          console.error("Transaction export stream failed:", error);
          res.destroy();
        }
      }
    } finally {
      req.removeListener("aborted", abortExport);
      res.removeListener("close", abortExport);

      if (disconnected && rowStream && !rowStream.destroyed) {
        rowStream.destroy();
      }

      releaseClient();
    }
  });

  return router;
}

export const exportRoutes = createExportRoutes();
