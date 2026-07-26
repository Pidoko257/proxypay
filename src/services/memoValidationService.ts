import {
  findExchangeAddress,
  type StellarMemoType,
} from "../config/exchangeAddresses";

/**
 * Result of a memo validation check.
 */
export interface MemoValidationResult {
  /** Whether the memo is valid for the destination */
  valid: boolean;
  /** Error code if invalid */
  errorCode?: string;
  /** Human-readable error message */
  errorMessage?: string;
  /** The required memo type for this address (if known exchange) */
  requiredMemoType?: StellarMemoType;
  /** The exchange name (if known exchange) */
  exchangeName?: string;
}

/**
 * Validate that a memo is present and of the correct type when sending
 * to a known exchange address that requires one.
 *
 * @param destinationAddress - The Stellar destination address
 * @param memo - The memo value provided (undefined if not provided)
 * @param memoType - The memo type provided (undefined if not provided)
 * @returns MemoValidationResult with validity and error details
 */
export function validateMemoForDestination(
  destinationAddress: string,
  memo?: string,
  memoType?: StellarMemoType,
): MemoValidationResult {
  const exchangeEntry = findExchangeAddress(destinationAddress);

  // Not a known exchange address — no memo requirement
  if (!exchangeEntry) {
    return { valid: true };
  }

  // Known exchange address — memo is required
  if (!memo || memo.trim().length === 0) {
    return {
      valid: false,
      errorCode: "ERR_MEMO_REQUIRED",
      errorMessage: `Payments to ${exchangeEntry.name} (${exchangeEntry.address}) require a "${exchangeEntry.requiredMemoType}" memo. ${exchangeEntry.description || "Please include the required memo."}`,
      requiredMemoType: exchangeEntry.requiredMemoType,
      exchangeName: exchangeEntry.name,
    };
  }

  // Memo provided, but check memo type if specified
  if (memoType && memoType !== exchangeEntry.requiredMemoType) {
    return {
      valid: false,
      errorCode: "ERR_MEMO_TYPE_MISMATCH",
      errorMessage: `Payments to ${exchangeEntry.name} require a "${exchangeEntry.requiredMemoType}" memo, but a "${memoType}" memo was provided. ${exchangeEntry.description || ""}`,
      requiredMemoType: exchangeEntry.requiredMemoType,
      exchangeName: exchangeEntry.name,
    };
  }

  return { valid: true };
}

/**
 * Check whether a destination address is a known exchange requiring a memo.
 * This is a lightweight check that doesn't validate the actual memo value.
 */
export function isKnownExchangeAddress(address: string): boolean {
  return findExchangeAddress(address) !== null;
}
