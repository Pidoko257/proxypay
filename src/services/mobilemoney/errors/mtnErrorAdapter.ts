/**
 * MTN MoMo — Provider Error Adapter
 *
 * Maps raw MTN API errors and HTTP responses into canonical ProviderError objects.
 *
 * MTN error format:
 *   { code: "PAYEE_NOT_FOUND", message: "..." }
 *   HTTP 409 → duplicate
 *   HTTP 500 → transient
 */

import { AxiosError } from "axios";
import {
  IProviderErrorAdapter,
  ProviderError,
  ProviderErrorCode,
  ProviderErrorContext,
} from "./providerErrors";

/**
 * MTN-specific error codes returned in the response body under `code`.
 * Reference: MTN MoMo API documentation.
 */
const MTN_CODE_MAP: Record<string, ProviderErrorCode> = {
  // Authentication
  invalid_client: ProviderErrorCode.AUTHENTICATION_FAILED,
  unauthorized: ProviderErrorCode.AUTHENTICATION_FAILED,

  // Recipient
  PAYEE_NOT_FOUND: ProviderErrorCode.RECIPIENT_NOT_FOUND,
  PAYER_NOT_FOUND: ProviderErrorCode.RECIPIENT_NOT_FOUND,
  NOT_ALLOWED: ProviderErrorCode.RECIPIENT_ACCOUNT_BLOCKED,
  NOT_ALLOWED_TARGET_ENVIRONMENT: ProviderErrorCode.INVALID_REQUEST,

  // Transaction
  RESOURCE_ALREADY_EXIST: ProviderErrorCode.DUPLICATE_TRANSACTION,
  DUPLICATED_REFERENCE_ID: ProviderErrorCode.DUPLICATE_TRANSACTION,
  LIMIT_REACHED: ProviderErrorCode.ACCOUNT_LIMIT_EXCEEDED,
  INVALID_AMOUNT: ProviderErrorCode.INVALID_AMOUNT,
  INVALID_CURRENCY: ProviderErrorCode.INVALID_CURRENCY,

  // Status values
  FAILED: ProviderErrorCode.TRANSACTION_FAILED,
  PENDING: ProviderErrorCode.TRANSACTION_PENDING,
  TIMEOUT: ProviderErrorCode.TRANSACTION_TIMEOUT,
  EXPIRED: ProviderErrorCode.TRANSACTION_TIMEOUT,
  REJECTED: ProviderErrorCode.TRANSACTION_CANCELLED,
};

const HTTP_STATUS_MAP: Record<number, ProviderErrorCode> = {
  400: ProviderErrorCode.INVALID_REQUEST,
  401: ProviderErrorCode.AUTHENTICATION_FAILED,
  403: ProviderErrorCode.AUTHENTICATION_FAILED,
  404: ProviderErrorCode.RECIPIENT_NOT_FOUND,
  409: ProviderErrorCode.DUPLICATE_TRANSACTION,
  429: ProviderErrorCode.RATE_LIMITED,
  500: ProviderErrorCode.SERVICE_UNAVAILABLE,
  502: ProviderErrorCode.SERVICE_UNAVAILABLE,
  503: ProviderErrorCode.SERVICE_UNAVAILABLE,
  504: ProviderErrorCode.TIMEOUT,
};

export class MTNErrorAdapter implements IProviderErrorAdapter {
  readonly providerName = "mtn";

  mapError(rawError: unknown, operation: string): ProviderError {
    const context: ProviderErrorContext = {
      provider: this.providerName,
      operation,
      originalError: rawError,
    };

    // ── Axios error with HTTP response ────────────────────────────────────────
    if (this.isAxiosError(rawError)) {
      const status = rawError.response?.status;
      const responseData = rawError.response?.data as Record<string, unknown> | undefined;

      context.httpStatus = status;
      context.rawCode = (responseData?.code as string) ?? String(status ?? "");
      context.rawMessage =
        (responseData?.message as string) ?? rawError.message;
      context.details = { responseData };

      // Prefer body error code, fall back to HTTP status
      const errorCode =
        (context.rawCode && MTN_CODE_MAP[context.rawCode as string]) ||
        (status !== undefined && HTTP_STATUS_MAP[status]) ||
        ProviderErrorCode.UNKNOWN;

      return new ProviderError(
        `MTN ${operation} failed: ${context.rawMessage ?? rawError.message}`,
        errorCode,
        context,
      );
    }

    // ── Network / non-HTTP errors ─────────────────────────────────────────────
    if (rawError instanceof Error) {
      context.rawMessage = rawError.message;
      const code = this.classifyNetworkError(rawError);
      return new ProviderError(
        `MTN ${operation} failed: ${rawError.message}`,
        code,
        context,
      );
    }

    // ── Unknown shape ──────────────────────────────────────────────────────────
    return new ProviderError(
      `MTN ${operation} failed: unknown error`,
      ProviderErrorCode.UNKNOWN,
      { ...context, rawMessage: String(rawError) },
    );
  }

  private isAxiosError(err: unknown): err is AxiosError {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as Record<string, unknown>).isAxiosError === true
    );
  }

  private classifyNetworkError(err: Error): ProviderErrorCode {
    const msg = err.message.toLowerCase();
    const code = (err as NodeJS.ErrnoException).code ?? "";

    if (/timeout|etimedout/i.test(msg) || code === "ETIMEDOUT") {
      return ProviderErrorCode.TIMEOUT;
    }
    if (/econnreset|econnrefused|enotfound|network/i.test(msg) || /^(ECONNRESET|ECONNREFUSED|ENOTFOUND)$/.test(code)) {
      return ProviderErrorCode.NETWORK_ERROR;
    }
    return ProviderErrorCode.UNKNOWN;
  }
}
