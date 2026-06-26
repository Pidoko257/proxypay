/**
 * Fee Calculation Engine
 *
 * Computes three fee components for every payment:
 *   1. ProxyPay tier fee  — percentage of transaction amount, clamped by min/max
 *   2. Operator flat fee  — fixed amount per provider + country combination
 *   3. Stellar network fee — constant (BASE_FEE stroops converted to XLM)
 *
 * Configuration is loaded from the database and cached in Redis for 5 minutes
 * (TTL: 300 s).  If Redis is unavailable, the DB is queried directly.
 */

import { pool } from "../config/database";
import { redisClient } from "../config/redis";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Stellar base fee in XLM (100 stroops = 0.00001 XLM). */
export const STELLAR_BASE_FEE_XLM = 0.00001;

const CACHE_TTL_SEC = 300; // 5 minutes
const TIER_CACHE_PREFIX = "fee_engine:tier:";
const OPERATOR_CACHE_PREFIX = "fee_engine:operator:";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TierFeeConfig {
  orgTier: string;
  feePercentage: number;
  feeMinimum: number;
  feeMaximum: number;
}

export interface OperatorFeeConfig {
  provider: string;
  countryCode: string;
  flatAmount: number;
}

export interface FeeBreakdown {
  proxypayFee: number;   // ProxyPay tier-based percentage fee
  operatorFee: number;   // Mobile-money operator flat fee
  stellarFee: number;    // Stellar network fee (XLM, informational)
  totalFee: number;      // proxypayFee + operatorFee (stellarFee excluded from fiat total)
  netAmount: number;     // amount - totalFee
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redisClient?.isOpen) return null;
  try {
    const raw = await redisClient.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: unknown): Promise<void> {
  if (!redisClient?.isOpen) return;
  try {
    await redisClient.setEx(key, CACHE_TTL_SEC, JSON.stringify(value));
  } catch {
    // cache is best-effort
  }
}

// ─── Config loaders ───────────────────────────────────────────────────────────

/**
 * Load the ProxyPay tier fee config for the given org tier.
 * Falls back to the 'standard' tier if no row is found for the requested tier.
 */
export async function loadTierConfig(orgTier: string): Promise<TierFeeConfig> {
  const cacheKey = `${TIER_CACHE_PREFIX}${orgTier}`;
  const cached = await cacheGet<TierFeeConfig>(cacheKey);
  if (cached) return cached;

  const { rows } = await pool.query<{
    org_tier: string;
    fee_percentage: string;
    fee_minimum: string;
    fee_maximum: string;
  }>(
    `SELECT org_tier, fee_percentage, fee_minimum, fee_maximum
     FROM fee_engine_tier_configs
     WHERE is_active = true AND org_tier = $1
     LIMIT 1`,
    [orgTier],
  );

  // Fallback to 'standard' if the requested tier has no config
  const row =
    rows[0] ??
    (await pool.query(
      `SELECT org_tier, fee_percentage, fee_minimum, fee_maximum
       FROM fee_engine_tier_configs
       WHERE is_active = true AND org_tier = 'standard'
       LIMIT 1`,
    )).rows[0];

  if (!row) {
    // Hard fallback when the table has no rows at all
    return { orgTier, feePercentage: 1.5, feeMinimum: 0, feeMaximum: Infinity };
  }

  const config: TierFeeConfig = {
    orgTier: row.org_tier,
    feePercentage: parseFloat(row.fee_percentage),
    feeMinimum: parseFloat(row.fee_minimum),
    feeMaximum: parseFloat(row.fee_maximum),
  };
  await cacheSet(cacheKey, config);
  return config;
}

/**
 * Load the operator flat-fee config for the given provider + country.
 * Returns zero if no matching config exists.
 */
export async function loadOperatorConfig(
  provider: string,
  countryCode: string,
): Promise<OperatorFeeConfig> {
  const cacheKey = `${OPERATOR_CACHE_PREFIX}${provider}:${countryCode}`;
  const cached = await cacheGet<OperatorFeeConfig>(cacheKey);
  if (cached) return cached;

  const { rows } = await pool.query<{
    provider: string;
    country_code: string;
    flat_amount: string;
  }>(
    `SELECT provider, country_code, flat_amount
     FROM fee_engine_operator_configs
     WHERE is_active = true AND provider = $1 AND country_code = $2
     LIMIT 1`,
    [provider.toLowerCase(), countryCode.toUpperCase()],
  );

  const config: OperatorFeeConfig = rows[0]
    ? {
        provider: rows[0].provider,
        countryCode: rows[0].country_code,
        flatAmount: parseFloat(rows[0].flat_amount),
      }
    : { provider, countryCode, flatAmount: 0 };

  await cacheSet(cacheKey, config);
  return config;
}

// ─── Main compute function ────────────────────────────────────────────────────

export interface ComputeFeeParams {
  amount: number;
  provider: string;
  countryCode: string;
  orgTier?: string; // defaults to 'standard'
}

/**
 * Compute the full fee breakdown for a payment.
 *
 * @param params.amount      Transaction amount in local currency (e.g. XAF)
 * @param params.provider    Mobile money provider: 'mtn' | 'airtel' | 'orange'
 * @param params.countryCode ISO 3166-1 alpha-2 country code (e.g. 'CM')
 * @param params.orgTier     Organisation tier; defaults to 'standard'
 */
export async function computeFee(params: ComputeFeeParams): Promise<FeeBreakdown> {
  const { amount, provider, countryCode, orgTier = "standard" } = params;

  const [tierConfig, operatorConfig] = await Promise.all([
    loadTierConfig(orgTier),
    loadOperatorConfig(provider, countryCode),
  ]);

  // ProxyPay percentage fee, clamped to [min, max]
  let proxypayFee = amount * (tierConfig.feePercentage / 100);
  if (proxypayFee < tierConfig.feeMinimum) proxypayFee = tierConfig.feeMinimum;
  if (proxypayFee > tierConfig.feeMaximum) proxypayFee = tierConfig.feeMaximum;
  proxypayFee = parseFloat(proxypayFee.toFixed(7));

  const operatorFee = parseFloat(operatorConfig.flatAmount.toFixed(7));
  const stellarFee = STELLAR_BASE_FEE_XLM;
  const totalFee = parseFloat((proxypayFee + operatorFee).toFixed(7));
  const netAmount = parseFloat((amount - totalFee).toFixed(7));

  return { proxypayFee, operatorFee, stellarFee, totalFee, netAmount };
}
