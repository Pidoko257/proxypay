import express, { Request, Response, NextFunction } from "express";
import webhookRoutes from "./routes/webhook";
import { config } from "./config/env";
import logger from "./logger";

// ── Shared typed error contract ─────────────────────────────────────────────
// Stable, machine-readable error codes. These codes are part of the public
// API contract and MUST NOT change across API versions.
export enum ErrorCode {
  BAD_REQUEST = "BAD_REQUEST",
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  NOT_FOUND = "NOT_FOUND",
  CONFLICT = "CONFLICT",
  UNPROCESSABLE_ENTITY = "UNPROCESSABLE_ENTITY",
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.UNPROCESSABLE_ENTITY]: 422,
  [ErrorCode.INTERNAL_ERROR]: 500,
};

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

// Expected domain error. Route handlers throw this and the shared error
// middleware maps it to a stable status code + machine-readable code.
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

// ── Sensitive data sanitization ─────────────────────────────────────────────
// Centralized scrub rules applied before any event/request data leaves the
// process (Sentry export, request logging, error logging). Covers payment
// payloads, credentials, phone numbers, and identity documents, including
// nested objects, query strings, and provider error bodies.
const REDACTED = "[REDACTED]";

// Field names (case-insensitive, matched as substrings) whose values must be
// scrubbed wherever they appear in a payload.
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /authorization/i,
  /credential/i,
  /cookie/i,
  /session/i,
  /card[-_]?number/i,
  /cardnumber/i,
  /cvv/i,
  /cvc/i,
  /pan/i,
  /iban/i,
  /account[-_]?number/i,
  /routing[-_]?number/i,
  /phone/i,
  /msisdn/i,
  /ssn/i,
  /social[-_]?security/i,
  /passport/i,
  /driver[-_]?licen[cs]e/i,
  /national[-_]?id/i,
  /identity[-_]?document/i,
  /id[-_]?document/i,
  /document[-_]?number/i,
  /date[-_]?of[-_]?birth/i,
  /dob/i,
];

// Query-string parameter names that must be scrubbed.
const SENSITIVE_QUERY_PATTERNS: RegExp[] = SENSITIVE_KEY_PATTERNS;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

function scrubQueryString(qs: string): string {
  if (!qs) return qs;
  const params = new URLSearchParams(qs);
  let changed = false;
  for (const key of Array.from(params.keys())) {
    if (SENSITIVE_QUERY_PATTERNS.some((re) => re.test(key))) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? params.toString() : qs;
}

function scrubUrl(url: string): string {
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return url;
  const base = url.slice(0, qIndex);
  const qs = url.slice(qIndex + 1);
  return `${base}?${scrubQueryString(qs)}`;
}

// Recursively scrub an arbitrary value. Handles nested objects/arrays, query
// strings embedded in URLs, and provider error bodies (which are often nested
// objects or JSON strings).
export function sanitize(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    // Scrub query strings embedded in URLs.
    if (value.includes("?")) return scrubUrl(value);
    return value;
  }

  if (typeof value !== "object") return value;

  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitize(value.message, seen),
      stack: value.stack,
    };
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = sanitize(val, seen);
    }
  }
  return out;
}

// Sanitize a Sentry event before export.
export function sanitizeSentryEvent<T extends Record<string, any>>(event: T): T {
  const scrubbed = sanitize(event) as T;
  if (scrubbed && typeof scrubbed === "object") {
    const req = (scrubbed as any).request;
    if (req && typeof req === "object") {
      if (typeof req.url === "string") req.url = scrubUrl(req.url);
      if (typeof req.query_string === "string") {
        req.query_string = scrubQueryString(req.query_string);
      }
    }
  }
  return scrubbed;
}

const app = express();

// Preserve raw request body buffer for signature verification middleware.
app.use(
  express.json({
    verify: (req: any, _res, buf: Buffer) => {
      req.rawBody = buf;
    },
  }),
);

// ── HTTP request / response logging ─────────────────────────────────────────
// Logs every inbound request and its outcome as a structured JSON line.
// Sensitive headers (Authorization, etc.) are redacted by the pino logger, and
// query strings are scrubbed via the centralized sanitizer.
app.use((req: Request, res: Response, next: NextFunction) => {
  const startMs = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startMs;
    const level = res.statusCode >= 500 ? "error"
                : res.statusCode >= 400 ? "warn"
                : "info";

    logger[level](
      {
        method: req.method,
        path: req.path,
        query: scrubQueryString(req.originalUrl.split("?")[1] ?? ""),
        statusCode: res.statusCode,
        durationMs,
        requestId: req.headers["x-request-id"] ?? undefined,
      },
      "HTTP request",
    );
  });

  next();
});

app.get("/", (_req: Request, res: Response) => {
  res.send("Bridge Starter API running 🚀");
});

app.use("/api", webhookRoutes);

// ── Shared error middleware ─────────────────────────────────────────────────
// Maps expected domain errors (ApiError) to their stable status + code, and
// falls back to a generic INTERNAL_ERROR for anything unexpected. Error data
// is sanitized before logging so provider error bodies never leak secrets.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    const body: ErrorResponse = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
    res.status(err.status).json(body);
    return;
  }

  logger.error({ err: sanitize(err) }, "Unhandled error");
  const body: ErrorResponse = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: "Internal server error",
    },
  };
  res.status(STATUS_BY_CODE[ErrorCode.INTERNAL_ERROR]).json(body);
});

app.listen(config.port, () => {
  logger.info({ port: config.port }, "Server started");
});
