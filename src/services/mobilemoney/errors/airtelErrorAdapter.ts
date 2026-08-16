/**
 * Airtel Money — Provider Error Adapter
 *
 * Maps raw Airtel API errors into canonical ProviderError objects.
 *
 * Airtel error format (direct API):
 *   { status: { success: false, code: "ESB000014", message: "Payee does not exist" } }
 *   HTTP 200 with success:false is an application-level failure.
 *   HTTP 4xx/5xx → transport-level failure.
 */

import { AxiosError } from "axios";
import {
  IProviderErrorAdapter,
  ProviderError,
  ProviderErrorCode,
  ProviderErrorContext,
} from "./providerErrors";

/**
 * Airtel-specific status codes from the `status.code` field.
 * These can appear on both successful HTTP 200 responses and error responses.
 */
const AIRTEL_CODE_MAP: Record<string, ProviderErrorCode> = {
  // Authentication
  DP00800001006: ProviderErrorCode.AUTHENTICATION_FAILED,
  ESB000025: ProviderErrorCode.TOKEN_EXPIRED,

  // Recipient
  ESB000014: ProviderErrorCode.RECIPIENT_NOT_FOUND,
  "400.03.03": ProviderErrorCode.RECIPIENT_NOT_FOUND,
  DP00900001001: ProviderErrorCode.RECIPIENT_ACCOUNT_BLOCKED,

  // Transaction
  DP00800001000: ProviderErrorCode.INSUFFICIENT_FUNDS,
  "400.04.01": ProviderErrorCode.INSUFFICIENT_FUNDS,
  ESB000033: ProviderErrorCode.DUPLICATE_TRANSACTION,
  DP00800001004: ProviderErrorCode.TRANSACTION_FAILED,
  "500.02.01": ProviderErrorCode.TRANSACTION_FAILED,
  ESYS000001: ProviderErrorCode.SERVICE_UNAVAILABLE,

  // Limits
  DP00800001003: ProviderErrorCode.ACCOUNT_LIMIT_EXCEEDED,
  "400.05.01": ProviderErrorCode.ACCOUNT_LIMIT_EXCEEDED,

  // Validation
  DP00800001005: ProviderErrorCode.INVALID_AMOUNT,
  "400.02.01": ProviderErrorCode.INVALID_REQUEST,
};

const HTTP_STATUS_MAP: Record<number, ProviderErrorCode> = {
  400: ProviderErrorCode.INVALID_REQUEST,
  401: ProviderErrorCode.AUTHENTICATION_FAILED,
  403: ProviderErrorCode.AUTHENTICATION_FAILED,
  404: ProviderErrorCode.RECIPIENT_NOT_FOUND,
  429: ProviderErrorCode.RATE_LIMITED,
  500: ProviderErrorCode.SERVICE_UNAVAILABLE,
  502: ProviderErrorCode.SERVICE_UNAVAILABLE,
  503: ProviderErrorCode.SERVICE_UNAVAILABLE,
  504: ProviderErrorCode.TIMEOUT,
};

export class AirtelErrorAdapter implements IProviderErrorAdapter {
  readonly providerName = "airtel";

  mapError(rawError: unknown, operation: string): ProviderError {
    const context: ProviderErrorContext = {
      provider: this.providerName,
      operation,
      originalError: rawError,
    };

    // ── Airtel application-level error (HTTP 200, success: false) ─────────────
    if (this.isAirtelAppError(rawError)) {
      const statusBlock = (rawError as Record<string, unknown>).status as Record<string, unknown>;
      context.rawCode = String(statusBlock.code ?? "");
      context.rawMessage = String(statusBlock.message ?? "Application error");
      context.details = { statusBlock };

      const errorCode =
        (context.rawCode && AIRTEL_CODE_MAP[context.rawCode]) ||
        ProviderErrorCode.TRANSACTION_FAILED;

      return new ProviderError(
        `Airtel ${operation} failed: ${context.rawMessage}`,
        errorCode,
        context,
      );
    }

    // ── Axios error with HTTP response ────────────────────────────────────────
    if (this.isAxiosError(rawError)) {
      const status = rawError.response?.status;
      const responseData = rawError.response?.data as Record<string, unknown> | undefined;
      const statusBlock = responseData?.status as Record<string, unknown> | undefined;

      context.httpStatus = status;
      context.rawCode =
        (statusBlock?.code as string) ?? String(status ?? "");
      context.rawMessage =
        (statusBlock?.message as string) ?? rawError.message;
      context.details = { responseData };

      const errorCode =
        (context.rawCode && AIRTEL_CODE_MAP[context.rawCode as string]) ||
        (status !== undefined && HTTP_STATUS_MAP[status]) ||
        ProviderErrorCode.UNKNOWN;

      return new ProviderError(
        `Airtel ${operation} failed: ${context.rawMessage}`,
        errorCode,
        context,
      );
    }

    // ── Network / non-HTTP errors ─────────────────────────────────────────────
    if (rawError instanceof Error) {
      context.rawMessage = rawError.message;
      const code = this.classifyNetworkError(rawError);
      return new ProviderError(
        `Airtel ${operation} failed: ${rawError.message}`,
        code,
        context,
      );
    }

    return new ProviderError(
      `Airtel ${operation} failed: unknown error`,
      ProviderErrorCode.UNKNOWN,
      { ...context, rawMessage: String(rawError) },
    );
  }

  private isAirtelAppError(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      "status" in err &&
      typeof (err as Record<string, unknown>).status === "object" &&
      (err as Record<string, unknown>).status !== null &&
      "success" in ((err as Record<string, unknown>).status as object) &&
      ((err as Record<string, Record<string, unknown>>).status.success === false)
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
