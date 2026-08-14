/**
 * FX Service
 *
 * Wraps CurrencyService with:
 *  - FX fee calculation and tracking
 *  - Currency-specific rounding rules
 *  - GraphQL-friendly result shapes
 *  - Settlement logic for multi-currency transactions
 */

import {
  currencyService,
  SUPPORTED_CURRENCIES,
  BASE_CURRENCY,
  type SupportedCurrency,
  type ConversionResult,
} from "./currency";
import { exchangeRateBufferService } from "./exchangeRateBufferService";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default FX fee percentage (e.g. 1.5%) charged on top of the converted amount */
const DEFAULT_FX_FEE_PERCENT = parseFloat(
  process.env.FX_FEE_PERCENT ?? "1.5",
);

/** Minimum FX fee amounts per currency (in smallest practical unit) */
const MIN_FX_FEE: Partial<Record<SupportedCurrency, number>> = {
  USD: 0.01,
  XAF: 5,
  NGN: 5,
  KES: 1,
  GHS: 0.05,
  TZS: 50,
  ZMW: 0.05,
  RWF: 5,
};

// ---------------------------------------------------------------------------
// Rounding rules per currency
// ---------------------------------------------------------------------------

const CURRENCY_DECIMAL_PLACES: Record<SupportedCurrency, number> = {
  USD: 2,
  XAF: 0, // CFA franc has no decimal places
  NGN: 2,
  KES: 2,
  GHS: 2,
  TZS: 0, // Tanzanian shilling no decimals
  ZMW: 2,
  RWF: 0, // Rwandan franc no decimals
};

/**
 * Round an amount to the correct number of decimal places for the given currency.
 */
export function roundForCurrency(
  amount: number,
  currency: SupportedCurrency,
): number {
  const dp = CURRENCY_DECIMAL_PLACES[currency] ?? 2;
  const factor = Math.pow(10, dp);
  return Math.round(amount * factor) / factor;
}

/**
 * Format a currency amount as string with correct precision.
 */
export function formatCurrencyAmount(
  amount: number,
  currency: SupportedCurrency,
): string {
  const dp = CURRENCY_DECIMAL_PLACES[currency] ?? 2;
  return amount.toFixed(dp);
}

// ---------------------------------------------------------------------------
// FX fee calculation
// ---------------------------------------------------------------------------

export interface FxFeeResult {
  /** Fee amount in the target (converted) currency */
  fxFee: number;
  /** Fee percent actually applied */
  fxFeePercent: number;
  /** Gross converted amount before fee deduction */
  grossConverted: number;
  /** Net amount user receives after fee deduction */
  netAmount: number;
  /** Currency of the fee */
  feeCurrency: SupportedCurrency;
}

export function calculateFxFee(
  grossConverted: number,
  toCurrency: SupportedCurrency,
  fxFeePercent: number = DEFAULT_FX_FEE_PERCENT,
): FxFeeResult {
  let fxFee = roundForCurrency(
    grossConverted * (fxFeePercent / 100),
    toCurrency,
  );

  // Apply minimum fee floor
  const minFee = MIN_FX_FEE[toCurrency] ?? 0;
  if (fxFee < minFee) fxFee = minFee;

  const netAmount = roundForCurrency(grossConverted - fxFee, toCurrency);

  return {
    fxFee,
    fxFeePercent,
    grossConverted,
    netAmount,
    feeCurrency: toCurrency,
  };
}

// ---------------------------------------------------------------------------
// Full conversion result (for GraphQL)
// ---------------------------------------------------------------------------

export interface FullConversionResult {
  fromCurrency: SupportedCurrency;
  toCurrency: SupportedCurrency;
  originalAmount: number;
  originalAmountStr: string;
  convertedAmount: number;
  convertedAmountStr: string;
  rate: number;
  rateStr: string;
  fxFee: number;
  fxFeeStr: string;
  fxFeePercent: number;
  fxFeePercentStr: string;
  netAmount: number;
  netAmountStr: string;
  fetchedAt: Date;
}

/**
 * Convert currency with FX fee applied.
 * If provider is given, uses the buffered (spread-adjusted) rate.
 */
export async function convertWithFee(
  amount: number,
  fromCurrency: SupportedCurrency,
  toCurrency: SupportedCurrency,
  provider?: string,
  direction: "sell" | "buy" = "sell",
): Promise<FullConversionResult> {
  let conversionResult: ConversionResult;

  if (provider) {
    const withBuffer = await currencyService.convertWithBuffer(
      amount,
      fromCurrency,
      toCurrency,
      provider,
      direction,
    );
    conversionResult = {
      originalAmount: withBuffer.originalAmount,
      originalCurrency: withBuffer.originalCurrency,
      convertedAmount: withBuffer.convertedAmount,
      baseCurrency: withBuffer.baseCurrency,
      rate: withBuffer.rate,
    };
  } else {
    conversionResult = currencyService.convert(amount, fromCurrency, toCurrency);
  }

  const feeResult = calculateFxFee(conversionResult.convertedAmount, toCurrency);

  return {
    fromCurrency,
    toCurrency,
    originalAmount: amount,
    originalAmountStr: formatCurrencyAmount(amount, fromCurrency),
    convertedAmount: conversionResult.convertedAmount,
    convertedAmountStr: formatCurrencyAmount(
      conversionResult.convertedAmount,
      toCurrency,
    ),
    rate: conversionResult.rate,
    rateStr: conversionResult.rate.toFixed(7),
    fxFee: feeResult.fxFee,
    fxFeeStr: formatCurrencyAmount(feeResult.fxFee, toCurrency),
    fxFeePercent: feeResult.fxFeePercent,
    fxFeePercentStr: feeResult.fxFeePercent.toFixed(4),
    netAmount: feeResult.netAmount,
    netAmountStr: formatCurrencyAmount(feeResult.netAmount, toCurrency),
    fetchedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Exchange rate queries
// ---------------------------------------------------------------------------

export interface ExchangeRateInfo {
  fromCurrency: SupportedCurrency;
  toCurrency: SupportedCurrency;
  rate: number;
  rateStr: string;
  bufferedRate?: number;
  bufferedRateStr?: string;
  bufferPercent?: number;
  bufferPercentStr?: string;
  fetchedAt: Date;
  isStale: boolean;
  usingFallback: boolean;
}

export async function getExchangeRate(
  fromCurrency: SupportedCurrency,
  toCurrency: SupportedCurrency,
  provider?: string,
): Promise<ExchangeRateInfo> {
  const rates = currencyService.getRates();
  const status = currencyService.getStatus();

  const fromRate = rates[fromCurrency];
  const toRate = rates[toCurrency];

  if (fromRate === undefined || toRate === undefined) {
    throw new Error(
      `No exchange rate available for ${fromCurrency} or ${toCurrency}`,
    );
  }

  const rate = toRate / fromRate;
  const info: ExchangeRateInfo = {
    fromCurrency,
    toCurrency,
    rate,
    rateStr: rate.toFixed(7),
    fetchedAt: status.lastUpdated ?? new Date(),
    isStale: status.isStale,
    usingFallback: status.usingFallback,
  };

  if (provider) {
    try {
      const buffered = await exchangeRateBufferService.applyBuffer(
        rate,
        provider,
        fromCurrency,
        toCurrency,
        "sell",
      );
      info.bufferedRate = buffered.bufferedRate;
      info.bufferedRateStr = buffered.bufferedRate.toFixed(7);
      info.bufferPercent = buffered.bufferApplied;
      info.bufferPercentStr = buffered.bufferApplied.toFixed(4);
    } catch {
      // Buffer not configured for this pair — return base rate
    }
  }

  return info;
}

export function getAllExchangeRates(
  baseCurrency?: SupportedCurrency,
): ExchangeRateInfo[] {
  const base = baseCurrency ?? BASE_CURRENCY;
  const status = currencyService.getStatus();
  const rates = currencyService.getRates();
  const baseRate = rates[base];

  if (baseRate === undefined) return [];

  return SUPPORTED_CURRENCIES.filter((c) => c !== base).map((currency) => {
    const toRate = rates[currency];
    const rate = toRate !== undefined ? toRate / baseRate : 0;
    return {
      fromCurrency: base,
      toCurrency: currency,
      rate,
      rateStr: rate.toFixed(7),
      fetchedAt: status.lastUpdated ?? new Date(),
      isStale: status.isStale,
      usingFallback: status.usingFallback,
    };
  });
}

// ---------------------------------------------------------------------------
// Supported currencies metadata
// ---------------------------------------------------------------------------

export interface CurrencyInfo {
  code: SupportedCurrency;
  name: string;
  symbol: string;
  minorUnits: number;
  minValue: string;
  maxValue: string;
}

const CURRENCY_META: Record<SupportedCurrency, CurrencyInfo> = {
  USD: {
    code: "USD",
    name: "US Dollar",
    symbol: "$",
    minorUnits: 2,
    minValue: "0.01",
    maxValue: "1000000.00",
  },
  XAF: {
    code: "XAF",
    name: "Central African CFA Franc",
    symbol: "FCFA",
    minorUnits: 0,
    minValue: "1",
    maxValue: "1000000000",
  },
  NGN: {
    code: "NGN",
    name: "Nigerian Naira",
    symbol: "₦",
    minorUnits: 2,
    minValue: "0.01",
    maxValue: "1000000000.00",
  },
  KES: {
    code: "KES",
    name: "Kenyan Shilling",
    symbol: "KSh",
    minorUnits: 2,
    minValue: "0.01",
    maxValue: "100000000.00",
  },
  GHS: {
    code: "GHS",
    name: "Ghanaian Cedi",
    symbol: "GH₵",
    minorUnits: 2,
    minValue: "0.01",
    maxValue: "1000000.00",
  },
  TZS: {
    code: "TZS",
    name: "Tanzanian Shilling",
    symbol: "TSh",
    minorUnits: 0,
    minValue: "1",
    maxValue: "1000000000",
  },
  ZMW: {
    code: "ZMW",
    name: "Zambian Kwacha",
    symbol: "ZK",
    minorUnits: 2,
    minValue: "0.01",
    maxValue: "10000000.00",
  },
  RWF: {
    code: "RWF",
    name: "Rwandan Franc",
    symbol: "FRw",
    minorUnits: 0,
    minValue: "1",
    maxValue: "1000000000",
  },
};

export function getSupportedCurrencies(): CurrencyInfo[] {
  return SUPPORTED_CURRENCIES.map((c) => CURRENCY_META[c]);
}

export function getCurrencyInfo(currency: SupportedCurrency): CurrencyInfo {
  return CURRENCY_META[currency];
}
