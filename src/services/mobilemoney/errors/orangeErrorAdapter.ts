/**
 * Orange Money — Provider Error Adapter
 *
 * Maps raw Orange API errors into canonical ProviderError objects.
 *
 * Orange error format (direct API):
 *   HTTP 4xx/5xx with body: { message: "...", code: "..." } or { error: "..." }
 *   Web-session mode returns HTML error pages parsed as strings.
 */

import { AxiosError } from "axios";
import {
  IProviderErrorAdapter,
  ProviderError,
  ProviderErrorCode,
  ProviderErrorContext,
} from "./providerErrors";

/**
 * Orange-specific error codes from the response body `code` field.
 */
const ORANGE_CODE_MAP: Record<string, ProviderErrorCode> = {
  // Authentication
  AUTH_FAILED: ProviderErrorCode.AUTHENTICATION_FAILED,
  INVALID_TOKEN: ProviderErrorCode.TOKEN_EXPIRED,
  SESSION_EXPIRED: ProviderErrorCode.TOKEN_EXPIRED,

  // Recipient
  PAYEE_NOT_FOUND: ProviderErrorCode.RECIPIENT_NOT_FOUND,
  ACCOUNT_NOT_FOUND: ProviderErrorCode.RECIPIENT_NOT_FOUND,
  ACCOUNT_BLOCKED: ProviderErrorCode.RECIPIENT_ACCOUNT_BLOCKED,
  ACCOUNT_SUSPENDED: ProviderErrorCode.RECIPIENT_ACCOUNT_BLOCKED,

  // Transaction
  INSUFFICIENT_BALANCE: ProviderErrorCode.INSUFFICIENT_FUNDS,
  BALANCE_INSUFFICIENT: ProviderErrorCode.INSUFFICIENT_FUNDS,
  DAILY_LIMIT_EXCEEDED: ProviderErrorCode.ACCOUNT_LIMIT_EXCEEDED,
  TRANSACTION_LIMIT: ProviderErrorCode.ACCOUNT_LIMIT_EXCEEDED,
  DUPLICATE_TRANSACTION: ProviderErrorCode.DUPLICATE_TRANSACTION,
  TRANSACTION_FAILED: ProviderErrorCode.TRANSACTION_FAILED,
  TRANSACTION_REJECTED: ProviderErrorCode.TRANSACTION_CANCELLED,

  // Validation
  INVALID_AMOUNT: ProviderErrorCode.INVALID_AMOUNT,
  INVALID_MSISDN: ProviderErrorCode.INVALID_RECIPIENT,
  INVALID_REQUEST: ProviderErrorCode.INVALID_REQUEST,

  // Availability
  SERVICE_UNAVAILABLE: ProviderErrorCode.SERVICE_UNAVAILABLE,
  MAINTENANCE: ProviderErrorCode.SERVICE_UNAVAILABLE,
  RATE_LIMIT_EXCEEDED: ProviderErrorCode.RATE_LIMITED,
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

export class OrangeErrorAdapter implements IProviderErrorAdapter {
  readonly providerName = "orange";

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
      // Orange can have either `code` or `error` as the key
      context.rawCode =
        (responseData?.code as string) ??
        (responseData?.error as string) ??
        String(status ?? "");
      context.rawMessage =
        (responseData?.message as string) ??
        (responseData?.error as string) ??
        rawError.message;
      context.details = { responseData };

      const codeKey = context.rawCode as string;
      const errorCode =
        (codeKey && ORANGE_CODE_MAP[codeKey]) ||
        (status !== undefined && HTTP_STATUS_MAP[status]) ||
        ProviderErrorCode.UNKNOWN;

      return new ProviderError(
        `Orange ${operation} failed: ${context.rawMessage}`,
        errorCode,
        context,
      );
    }

    // ── Orange-specific structured error objects ───────────────────────────────
    if (this.isOrangeErrorObject(rawError)) {
      const obj = rawError as Record<string, unknown>;
      context.rawCode = String(obj.code ?? obj.error ?? "");
      context.rawMessage = String(obj.message ?? obj.error ?? "Application error");
      context.details = { rawObj: obj };

      const errorCode =
        (context.rawCode && ORANGE_CODE_MAP[context.rawCode]) ||
        ProviderErrorCode.TRANSACTION_FAILED;

      return new ProviderError(
        `Orange ${operation} failed: ${context.rawMessage}`,
        errorCode,
        context,
      );
    }

    // ── Plain JS Error ─────────────────────────────────────────────────────────
    if (rawError instanceof Error) {
      context.rawMessage = rawError.message;
      const code = this.classifyNetworkError(rawError);
      return new ProviderError(
        `Orange ${operation} failed: ${rawError.message}`,
        code,
        context,
      );
    }

    return new ProviderError(
      `Orange ${operation} failed: unknown error`,
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

  private isOrangeErrorObject(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false;
    const obj = err as Record<string, unknown>;
    return (
      typeof obj.code === "string" ||
      typeof obj.error === "string" ||
      typeof obj.message === "string"
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
