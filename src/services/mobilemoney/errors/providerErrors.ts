/**
 * Provider-Specific Error Handling — Issue #164
 *
 * Unified error types and adapter pattern for mapping raw provider
 * error responses into a consistent internal error format.
 */

import logger from "../../../utils/logger";

// ─── Canonical provider error categories ─────────────────────────────────────

export enum ProviderErrorCode {
  // Authentication / credentials
  AUTHENTICATION_FAILED = "PROVIDER_AUTH_FAILED",
  TOKEN_EXPIRED = "PROVIDER_TOKEN_EXPIRED",
  INVALID_API_KEY = "PROVIDER_INVALID_API_KEY",

  // Insufficient funds
  INSUFFICIENT_FUNDS = "PROVIDER_INSUFFICIENT_FUNDS",
  ACCOUNT_LIMIT_EXCEEDED = "PROVIDER_ACCOUNT_LIMIT_EXCEEDED",

  // Recipient issues
  INVALID_RECIPIENT = "PROVIDER_INVALID_RECIPIENT",
  RECIPIENT_NOT_FOUND = "PROVIDER_RECIPIENT_NOT_FOUND",
  RECIPIENT_ACCOUNT_BLOCKED = "PROVIDER_RECIPIENT_ACCOUNT_BLOCKED",

  // Transaction
  DUPLICATE_TRANSACTION = "PROVIDER_DUPLICATE_TRANSACTION",
  TRANSACTION_NOT_FOUND = "PROVIDER_TRANSACTION_NOT_FOUND",
  TRANSACTION_FAILED = "PROVIDER_TRANSACTION_FAILED",
  TRANSACTION_CANCELLED = "PROVIDER_TRANSACTION_CANCELLED",
  TRANSACTION_TIMEOUT = "PROVIDER_TRANSACTION_TIMEOUT",
  TRANSACTION_PENDING = "PROVIDER_TRANSACTION_PENDING",

  // Request / validation
  INVALID_REQUEST = "PROVIDER_INVALID_REQUEST",
  INVALID_AMOUNT = "PROVIDER_INVALID_AMOUNT",
  INVALID_CURRENCY = "PROVIDER_INVALID_CURRENCY",

  // Rate limiting / throttling
  RATE_LIMITED = "PROVIDER_RATE_LIMITED",
  QUOTA_EXCEEDED = "PROVIDER_QUOTA_EXCEEDED",

  // Service availability
  SERVICE_UNAVAILABLE = "PROVIDER_SERVICE_UNAVAILABLE",
  NETWORK_ERROR = "PROVIDER_NETWORK_ERROR",
  TIMEOUT = "PROVIDER_TIMEOUT",

  // Generic / unknown
  UNKNOWN = "PROVIDER_UNKNOWN_ERROR",
}

/** Whether the error is transient (safe to retry) */
export const TRANSIENT_PROVIDER_ERRORS = new Set<ProviderErrorCode>([
  ProviderErrorCode.SERVICE_UNAVAILABLE,
  ProviderErrorCode.NETWORK_ERROR,
  ProviderErrorCode.TIMEOUT,
  ProviderErrorCode.TRANSACTION_TIMEOUT,
  ProviderErrorCode.RATE_LIMITED,
  ProviderErrorCode.QUOTA_EXCEEDED,
  ProviderErrorCode.TRANSACTION_PENDING,
]);

// ─── Unified provider error class ─────────────────────────────────────────────

export interface ProviderErrorContext {
  provider: string;
  operation: string;
  /** Raw error code from the provider's API */
  rawCode?: string | number;
  /** Raw message from the provider's API */
  rawMessage?: string;
  /** HTTP status code (if applicable) */
  httpStatus?: number;
  /** Provider-specific extra details */
  details?: Record<string, unknown>;
  /** Original error object */
  originalError?: unknown;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly code: ProviderErrorCode;
  readonly rawCode?: string | number;
  readonly rawMessage?: string;
  readonly httpStatus?: number;
  readonly details?: Record<string, unknown>;
  readonly originalError?: unknown;
  readonly isTransient: boolean;
  readonly timestamp: Date;

  constructor(
    message: string,
    code: ProviderErrorCode,
    context: ProviderErrorContext,
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = context.provider;
    this.operation = context.operation;
    this.code = code;
    this.rawCode = context.rawCode;
    this.rawMessage = context.rawMessage;
    this.httpStatus = context.httpStatus;
    this.details = context.details;
    this.originalError = context.originalError;
    this.isTransient = TRANSIENT_PROVIDER_ERRORS.has(code);
    this.timestamp = new Date();

    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ProviderError);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      provider: this.provider,
      operation: this.operation,
      code: this.code,
      rawCode: this.rawCode,
      rawMessage: this.rawMessage,
      httpStatus: this.httpStatus,
      isTransient: this.isTransient,
      timestamp: this.timestamp.toISOString(),
      details: this.details,
    };
  }
}

// ─── Adapter interface ────────────────────────────────────────────────────────

/**
 * Implementors translate raw provider responses/errors into a ProviderError.
 */
export interface IProviderErrorAdapter {
  readonly providerName: string;
  /**
   * Map a raw error (axios error, provider response object, or unknown) to a
   * canonical ProviderError.
   */
  mapError(rawError: unknown, operation: string): ProviderError;
}

// ─── Logging helper ───────────────────────────────────────────────────────────

export function logProviderError(error: ProviderError): void {
  logger.error(
    {
      provider: error.provider,
      operation: error.operation,
      code: error.code,
      rawCode: error.rawCode,
      rawMessage: error.rawMessage,
      httpStatus: error.httpStatus,
      isTransient: error.isTransient,
      details: error.details,
    },
    `[ProviderError] ${error.provider}/${error.operation}: ${error.message}`,
  );
}
