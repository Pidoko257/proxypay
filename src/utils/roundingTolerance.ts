/**
 * Rounding Tolerance Utilities for Accounting Reconciliation
 * 
 * Handles comparison of monetary amounts with tolerance for rounding errors.
 * Standard tolerance threshold: 0.01 (one cent)
 */

/**
 * Rounding tolerance threshold in currency units (0.01 = one cent)
 */
export const ROUNDING_TOLERANCE = 0.01;

/**
 * Account for floating-point precision errors by rounding to 10 decimal places
 * before comparison. This helps avoid issues with binary representation of decimals.
 */
const PRECISION_DIGITS = 10;

/**
 * Normalize a number by rounding to a safe decimal precision
 * This prevents floating-point arithmetic errors
 */
function normalizePrecision(value: number): number {
  return Math.round(value * Math.pow(10, PRECISION_DIGITS)) / Math.pow(10, PRECISION_DIGITS);
}

/**
 * Checks if the difference between two amounts is within the rounding tolerance.
 * 
 * @param amount1 - First amount to compare
 * @param amount2 - Second amount to compare
 * @param tolerance - Optional custom tolerance (defaults to ROUNDING_TOLERANCE)
 * @returns true if absolute difference is within tolerance, false otherwise
 * 
 * @example
 * isWithinTolerance(100.001, 100.00) // true (diff = 0.001)
 * isWithinTolerance(100.02, 100.00) // false (diff = 0.02)
 */
export function isWithinTolerance(
  amount1: number,
  amount2: number,
  tolerance: number = ROUNDING_TOLERANCE
): boolean {
  const diff = normalizePrecision(Math.abs(amount1 - amount2));
  const normalizedTolerance = normalizePrecision(tolerance);
  return diff <= normalizedTolerance;
}

/**
 * Calculates the rounding error between two amounts.
 * 
 * @param expectedAmount - The expected or reference amount
 * @param actualAmount - The actual or observed amount
 * @returns The signed difference (negative if actual < expected, positive if actual > expected)
 * 
 * @example
 * getRoundingError(100.00, 100.01) // 0.01
 * getRoundingError(100.00, 99.99) // -0.01
 */
export function getRoundingError(
  expectedAmount: number,
  actualAmount: number
): number {
  return normalizePrecision(actualAmount - expectedAmount);
}

/**
 * Determines if a difference qualifies as a rounding error.
 * A rounding error is a small difference within the tolerance threshold
 * that should be automatically adjusted rather than requiring manual intervention.
 * 
 * @param expectedAmount - The expected or reference amount
 * @param actualAmount - The actual or observed amount
 * @param tolerance - Optional custom tolerance (defaults to ROUNDING_TOLERANCE)
 * @returns true if the difference is a rounding error, false otherwise
 * 
 * @example
 * isRoundingError(100.00, 100.005, 0.01) // true
 * isRoundingError(100.00, 100.05, 0.01) // false
 */
export function isRoundingError(
  expectedAmount: number,
  actualAmount: number,
  tolerance: number = ROUNDING_TOLERANCE
): boolean {
  return isWithinTolerance(expectedAmount, actualAmount, tolerance) &&
         expectedAmount !== actualAmount;
}

/**
 * Rounds a monetary amount to the nearest cent (2 decimal places).
 * Uses standard rounding (round half up).
 * 
 * @param amount - The amount to round
 * @returns The rounded amount to 2 decimal places
 * 
 * @example
 * roundToNearestCent(100.005) // 100.01
 * roundToNearestCent(100.004) // 100.00
 */
export function roundToNearestCent(amount: number): number {
  // For negative numbers, we need to adjust the rounding behavior
  // to ensure we always round "away from zero" for the magnitude
  const sign = amount < 0 ? -1 : 1;
  const absAmount = Math.abs(amount);
  const rounded = Math.round(absAmount * 100) / 100;
  return normalizePrecision(sign * rounded);
}

/**
 * Formats a monetary amount as a string with exactly 2 decimal places.
 * Useful for consistent logging and reporting.
 * 
 * @param amount - The amount to format
 * @returns Formatted string with 2 decimal places
 * 
 * @example
 * formatAmount(100) // "100.00"
 * formatAmount(100.5) // "100.50"
 */
export function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

/**
 * Validates if a value is a valid monetary amount.
 * Valid amounts are non-negative numbers.
 * 
 * @param amount - The amount to validate
 * @returns true if valid, false otherwise
 */
export function isValidMonetaryAmount(amount: number): boolean {
  return typeof amount === 'number' && !isNaN(amount) && isFinite(amount) && amount >= 0;
}
