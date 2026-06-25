import { ERROR_CODES } from "../../../constants/errorCodes";

/**
 * Maps Airtel Money API error codes to ProxyPay internal error codes.
 * Reference: Airtel Africa Open API docs (collection + disbursement).
 */
const AIRTEL_ERROR_MAP: Record<string, string> = {
  // Authentication
  "401":           ERROR_CODES.UNAUTHORIZED,
  "403":           ERROR_CODES.FORBIDDEN,

  // Subscriber / account
  "ESB000010":     ERROR_CODES.NOT_FOUND,          // Subscriber not found
  "ESB000033":     ERROR_CODES.NOT_FOUND,          // Account not found
  "ESB000022":     ERROR_CODES.FORBIDDEN,          // Account not active
  "ESB000026":     ERROR_CODES.FORBIDDEN,          // Account blocked

  // Funds
  "ESB000008":     ERROR_CODES.INSUFFICIENT_FUNDS, // Insufficient balance
  "ESB000009":     ERROR_CODES.INSUFFICIENT_FUNDS, // Below minimum amount
  "ESB000011":     ERROR_CODES.LIMIT_EXCEEDED,     // Daily limit exceeded
  "ESB000012":     ERROR_CODES.LIMIT_EXCEEDED,     // Transaction limit exceeded

  // Duplicate / conflict
  "ESB000007":     ERROR_CODES.DUPLICATE_REQUEST,  // Duplicate transaction ID

  // Validation
  "ESB000004":     ERROR_CODES.INVALID_INPUT,      // Invalid MSISDN
  "ESB000005":     ERROR_CODES.INVALID_AMOUNT,     // Invalid amount
  "ESB000006":     ERROR_CODES.INVALID_INPUT,      // Invalid currency

  // Provider / system
  "ESB000001":     ERROR_CODES.PROVIDER_ERROR,     // System error
  "ESB000002":     ERROR_CODES.SERVICE_UNAVAILABLE,// Service unavailable
  "ESB000003":     ERROR_CODES.PROVIDER_ERROR,     // Internal error
  "ESB000099":     ERROR_CODES.PROVIDER_ERROR,     // Unknown error

  // Transaction terminal states
  "TS":            ERROR_CODES.TRANSACTION_FAILED, // Never mapped as error (success state)
  "TF":            ERROR_CODES.TRANSACTION_FAILED, // Transaction failed
  "TA":            ERROR_CODES.TRANSACTION_FAILED, // Transaction abandoned / timed-out
};

/**
 * Normalizes an Airtel error code (from response body or HTTP status) to a
 * ProxyPay internal error code.  Falls back to PROVIDER_ERROR for unmapped codes.
 */
export function normalizeAirtelError(airtelCode: string | number): string {
  const key = String(airtelCode).trim().toUpperCase();
  return AIRTEL_ERROR_MAP[key] ?? ERROR_CODES.PROVIDER_ERROR;
}
