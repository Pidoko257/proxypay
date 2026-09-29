/**
 * Banker's Rounding (Round Half to Even) Implementation
 *
 * In financial systems, standard round-half-up (Math.round) introduces an upward
 * statistical bias because 0.5 always rounds up. Over large numbers of transactions
 * and reconciliation runs, this causes off-by-cent discrepancies.
 *
 * Banker's Rounding (IEEE 754 half-to-even) rounds ties (exactly halfway) to the
 * nearest EVEN number, ensuring an even distribution of round-ups and round-downs.
 */

import { CurrencyConfig } from './CurrencyConfig';

/**
 * Rounds a number to the specified number of decimal places using Banker's Rounding (half-to-even).
 *
 * @param value The numeric value to round.
 * @param decimals Number of decimal places (defaults to 0).
 * @returns The rounded number.
 */
export function roundHalfEven(value: number, decimals: number = 0): number {
  if (!Number.isFinite(value)) {
    return value;
  }

  const sign = value < 0 ? -1 : 1;
  const absValue = Math.abs(value);

  // Shift decimal point using scientific notation to avoid IEEE 754 precision drift
  const shifted = Number(`${absValue}e+${decimals}`);
  const floor = Math.floor(shifted);
  const diff = shifted - floor;

  let rounded: number;
  const EPSILON = 1e-9;

  if (Math.abs(diff - 0.5) < EPSILON) {
    // Exactly halfway: round to nearest even integer
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else if (diff < 0.5) {
    rounded = floor;
  } else {
    rounded = floor + 1;
  }

  return sign * Number(`${rounded}e-${decimals}`);
}

/**
 * Alias for roundHalfEven
 */
export const bankersRound = roundHalfEven;

/**
 * Rounds an amount for a specific currency using Banker's Rounding according to the currency's minor units.
 *
 * @param amount Numeric amount
 * @param currencyCode ISO 4217 currency code (e.g. USD, XAF, GHS, NGN)
 * @returns Rounded amount
 */
export function roundCurrencyBankers(amount: number, currencyCode: string): number {
  const rule = CurrencyConfig.getCurrencyRule(currencyCode);
  return roundHalfEven(amount, rule.minorUnits);
}