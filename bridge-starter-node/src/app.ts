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

// ── Required translation gating ─────────────────────────────────────────────
// Locales that MUST be fully translated before a deploy is allowed.
// Keep in sync with the translations validator config consumed by CI.
export const REQUIRED_LOCALES = ["en", "es", "fr", "de"] as const;

// Critical user-facing keys (payment / compliance). A runtime fallback for
// any of these means a required translation is missing and must be alerted.
export const CRITICAL_TRANSLATION_KEYS = [
  "payment.checkout.title",
  "payment.checkout.confirm",
  "payment.receipt.subject",
  "payment.failed.body",
  "compliance.terms.accept",
  "compliance.privacy.notice",
  "compliance.refund.policy",
] as const;

// ── Runtime fallback detection ──────────────────────────────────────────────
// i18next emits a "missingKey" event whenever it falls back to a fallback
// locale (or the key itself) for a requested translation. We surface those
// events as structured logs and escalate critical payment/compliance keys to
// an error-level alert so monitoring can page before bad copy ships.
export interface MissingKeyEvent {
  lng?: string;
  ns?: string;
  key?: string;
  fallbackValue?: string;
}

export function reportTranslationFallback(event: MissingKeyEvent): void {
  const key = event.key ?? "";
  const isCritical = (CRITICAL_TRANSLATION_KEYS as readonly string[]).includes(key);

  const payload = {
    locale: event.lng,
    namespace: event.ns,
    key,
    fallbackValue: event.fallbackValue,
    critical: isCritical,
  };

  if (isCritical) {
    logger.error(payload, "Critical translation fallback used");
    return;
  }

  logger.warn(payload, "Translation fallback used");
}

// Attach the fallback listener to an i18next instance. Kept dependency-free
// (structural typing) so this module does not import i18next directly.
export function registerTranslationFallbackAlerting(i18n: {
  on: (event: "missingKey", cb: (lng: string, ns: string, key: string, fallbackValue: string) => void) => void;
}): void {
  i18n.on("missingKey", (lng, ns, key, fallbackValue) => {
    reportTranslationFallback({ lng, ns, key, fallbackValue });
  });
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
// Sensitive headers (Authorization, etc.) are redacted by the pino logger.
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
// falls back to a generic INTERNAL_ERROR for anything unexpected.
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

  logger.error({ err }, "Unhandled error");
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
