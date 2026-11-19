/**
 * Structured Pino logger for bridge-starter-node.
 *
 * Every log line is emitted as a single JSON object containing:
 *   - time        ISO-8601 timestamp
 *   - level       uppercase label (INFO, WARN, ERROR, DEBUG)
 *   - service     constant "bridge-starter-node"
 *   - env         NODE_ENV value
 *   - msg         human-readable message
 *   - ...context  any extra fields passed by the caller
 *
 * Transport:
 *   - Production / CI  → raw JSON to stdout (pipe to log aggregator)
 *   - Development      → pino-pretty for human-readable coloured output
 *                        (enabled when LOG_PRETTY=true or NODE_ENV=development)
 *
 * Log level is controlled by the LOG_LEVEL env var (default: "info").
 * Valid values: trace | debug | info | warn | error | fatal
 *
 * Usage:
 *   import logger from './logger';
 *
 *   logger.info('Server started');
 *   logger.info({ port: 3000 }, 'Server started');
 *   logger.error({ err }, 'Payment failed');
 *
 *   // Child logger — binds extra fields to every line in a scope
 *   const reqLog = logger.child({ requestId: req.headers['x-request-id'] });
 *   reqLog.info({ method: req.method, path: req.path }, 'Incoming request');
 */

import pino, { type Logger, type TransportSingleOptions } from "pino";

const SERVICE_NAME = "bridge-starter-node";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

const isDev =
  process.env.NODE_ENV === "development" || process.env.LOG_PRETTY === "true";

/**
 * In development, route output through pino-pretty for readable logs.
 * In all other environments write raw JSON so log aggregators (Loki,
 * Datadog, CloudWatch, etc.) can parse the lines without transformation.
 */
function buildTransport(): TransportSingleOptions | undefined {
  if (!isDev) return undefined;

  return {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard", // human-readable local time in dev
      ignore: "pid,hostname",        // reduce noise in terminal output
    },
  };
}

const transport = buildTransport();

const logger: Logger = pino(
  {
    level: LOG_LEVEL,

    // Bind service name and environment to every log line so log aggregators
    // can filter by service without parsing the message field.
    base: {
      service: SERVICE_NAME,
      env: process.env.NODE_ENV ?? "development",
    },

    // Emit level as an uppercase string label (INFO, WARN, …) to match the
    // convention used by the main proxypay-api service.
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },

    // ISO-8601 timestamps — compatible with Loki, ELK, and CloudWatch.
    timestamp: pino.stdTimeFunctions.isoTime,

    // Redact common sensitive fields so they are never written to any sink.
    // Extend this list as new sensitive fields are introduced.
    redact: {
      paths: [
        "authorization",
        "*.authorization",
        "headers.authorization",
        "*.headers.authorization",
        "req.headers.authorization",
        "apiKey",
        "*.apiKey",
        "secret",
        "*.secret",
        "password",
        "*.password",
        "token",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
  },
  transport ? pino.transport(transport) : undefined,
);

export default logger;

/**
 * Create a child logger pre-bound with a set of fields.
 * Use this inside request handlers to attach a request-scoped trace ID
 * to every log line without passing the logger explicitly:
 *
 *   const reqLog = childLogger({ requestId: req.headers['x-request-id'] });
 *   reqLog.info({ method: req.method }, 'Incoming request');
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

/**
 * Bounded error-code taxonomy for provider failures.
 *
 * Prometheus labels must stay low-cardinality, so provider failures are
 * mapped to this small fixed set of codes instead of free-form error
 * reasons. Free-form details belong in structured logs (see
 * `logProviderFailure`), never in metric labels.
 */
export const PROVIDER_ERROR_CODES = [
  "timeout",
  "connection",
  "rate_limited",
  "auth",
  "bad_request",
  "server_error",
  "invalid_response",
  "unknown",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/**
 * Map an arbitrary provider failure to a bounded error code.
 *
 * Accepts an Error, a string reason, or an HTTP status code and returns one
 * of the fixed `PROVIDER_ERROR_CODES`. Anything unrecognised collapses to
 * "unknown" so the label set can never grow unbounded.
 */
export function toProviderErrorCode(
  failure: unknown,
  status?: number,
): ProviderErrorCode {
  if (typeof status === "number") {
    if (status === 401 || status === 403) return "auth";
    if (status === 408 || status === 504) return "timeout";
    if (status === 429) return "rate_limited";
    if (status >= 400 && status < 500) return "bad_request";
    if (status >= 500) return "server_error";
  }

  const raw =
    failure instanceof Error
      ? `${failure.name} ${failure.message}`
      : typeof failure === "string"
        ? failure
        : "";
  const text = raw.toLowerCase();

  if (!text) return "unknown";
  if (/timeout|timed out|etimedout|deadline/.test(text)) return "timeout";
  if (/econnrefused|econnreset|enotfound|eai_again|socket|network|connection/.test(text))
    return "connection";
  if (/rate.?limit|too many requests|429/.test(text)) return "rate_limited";
  if (/unauthor|forbidden|invalid.?api.?key|401|403/.test(text)) return "auth";
  if (/invalid.?response|parse|malformed|unexpected.?payload/.test(text))
    return "invalid_response";
  if (/bad.?request|validation|400/.test(text)) return "bad_request";
  if (/server.?error|internal|5\d\d/.test(text)) return "server_error";

  return "unknown";
}

/**
 * Log a provider failure with its bounded error code plus the free-form
 * details. The bounded code is safe to use as a Prometheus label; the
 * free-form `reason`/`error` fields stay in structured logs only.
 */
export function logProviderFailure(
  provider: string,
  failure: unknown,
  status?: number,
): ProviderErrorCode {
  const code = toProviderErrorCode(failure, status);
  logger.error(
    {
      provider,
      errorCode: code,
      status,
      reason: failure instanceof Error ? failure.message : failure,
      err: failure instanceof Error ? failure : undefined,
    },
    "Provider failure",
  );
  return code;
}
