/**
 * AML Screening Service
 *
 * Evaluates a transaction synchronously against configurable rules stored in the
 * `aml_rules` table before the transaction is created.  Rule results are logged
 * to `aml_screening_results`.
 *
 * Supported rule types:
 *  • amount_threshold  – flag if amount >= config.threshold_xaf
 *  • velocity_check    – flag if phone sent > config.max_count txns in
 *                        config.window_seconds seconds (Redis counter)
 *  • blacklisted_phone – flag if phone number is in config.numbers[]
 *
 * Any triggered rule causes the transaction to be created with status
 * `pending_review` instead of `pending`.
 */

import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import {
  AmlScreeningResultModel,
  AmlRuleType,
  CreateAmlScreeningResultInput,
} from "../models/amlScreeningResult";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Shape of a row in aml_rules */
export interface AmlRule {
  id: string;
  ruleType: AmlRuleType;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
}

/** Per-rule evaluation result (before writing to DB) */
export interface RuleEvaluation {
  rule: AmlRule;
  triggered: boolean;
  details: Record<string, unknown>;
}

/** Return value of screenTransaction() */
export interface ScreeningOutcome {
  /** True when at least one rule was triggered */
  shouldFlag: boolean;
  /** Rules that fired */
  matchedRules: RuleEvaluation[];
  /** All rules that were checked (including non-triggered) */
  allEvaluations: RuleEvaluation[];
}

/** Input required to screen a transaction */
export interface ScreenTransactionInput {
  /** Temporary ID used for Redis keys only; the real DB id is set after creation */
  transactionId: string;
  userId: string;
  amount: number;
  phoneNumber: string;
  type: "deposit" | "withdraw";
}

// ─── Config ──────────────────────────────────────────────────────────────────

/** TTL for the in-memory rules cache (ms). */
const RULE_CACHE_TTL_MS = Number(process.env.AML_RULE_CACHE_TTL_MS ?? 60_000);

/** Redis key prefix for velocity counters. */
const VELOCITY_KEY_PREFIX = "aml:velocity:";

// ─── Service ─────────────────────────────────────────────────────────────────

export class AmlScreeningService {
  private readonly resultModel: AmlScreeningResultModel;

  /** In-process rule cache to avoid hitting PG on every transaction. */
  private cachedRules: AmlRule[] | null = null;
  private cacheLoadedAt = 0;

  constructor(resultModel?: AmlScreeningResultModel) {
    this.resultModel = resultModel ?? new AmlScreeningResultModel();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Screen a transaction against all enabled AML rules.
   *
   * This is the primary synchronous entry point called before the transaction
   * record is written to the database.
   *
   * @param input - Transaction data to evaluate
   * @param persistTransactionId - ID to use when writing to aml_screening_results.
   *   Pass the newly created transaction ID here when you have it, or the same
   *   `input.transactionId` if you call this before DB creation and update later.
   */
  async screenTransaction(
    input: ScreenTransactionInput,
    persistTransactionId?: string,
  ): Promise<ScreeningOutcome> {
    const rules = await this.loadRules();
    const evaluations: RuleEvaluation[] = [];

    // Evaluate each rule, running velocity checks in parallel where possible.
    // We serialise for simplicity; the Redis calls are fast enough.
    for (const rule of rules) {
      const evaluation = await this.evaluateRule(rule, input);
      evaluations.push(evaluation);
    }

    const matchedRules = evaluations.filter((e) => e.triggered);
    const shouldFlag = matchedRules.length > 0;

    // Persist all evaluations (fire-and-forget errors; screening must not block)
    const txId = persistTransactionId ?? input.transactionId;
    this.persistResults(txId, evaluations).catch((err) => {
      console.error("[AmlScreening] Failed to persist screening results:", err);
    });

    return { shouldFlag, matchedRules, allEvaluations: evaluations };
  }

  /**
   * Increment the velocity counter for a phone number.
   * Call this after a transaction is successfully committed so the counter
   * reflects only completed/pending transactions.
   *
   * Returns the new counter value for each window that was updated.
   */
  async incrementVelocityCounters(
    phoneNumber: string,
    windowsSeconds: number[],
  ): Promise<Record<number, number>> {
    const results: Record<number, number> = {};

    for (const window of windowsSeconds) {
      const key = this.velocityKey(phoneNumber, window);
      try {
        const newCount = await redisClient.incr(key);
        // Set expiry only on first increment to avoid resetting the window
        if (newCount === 1) {
          await redisClient.expire(key, window);
        }
        results[window] = newCount;
      } catch (err) {
        console.error(`[AmlScreening] Redis incr failed for key ${key}:`, err);
        results[window] = 0;
      }
    }

    return results;
  }

  /**
   * Force-flush the in-memory rule cache on the next load.
   * Useful after an operator updates a rule via the DB.
   */
  invalidateRuleCache(): void {
    this.cachedRules = null;
    this.cacheLoadedAt = 0;
  }

  // ─── Rule loading ──────────────────────────────────────────────────────────

  /**
   * Load enabled rules from Postgres, backed by a short in-process cache.
   */
  async loadRules(): Promise<AmlRule[]> {
    const now = Date.now();
    if (this.cachedRules !== null && now - this.cacheLoadedAt < RULE_CACHE_TTL_MS) {
      return this.cachedRules;
    }

    const result = await pool.query<{
      id: string;
      rule_type: AmlRuleType;
      name: string;
      description: string | null;
      config: Record<string, unknown>;
      enabled: boolean;
    }>(`
      SELECT id, rule_type, name, description, config, enabled
      FROM aml_rules
      WHERE enabled = TRUE
      ORDER BY created_at ASC
    `);

    this.cachedRules = result.rows.map((row) => ({
      id: row.id,
      ruleType: row.rule_type,
      name: row.name,
      description: row.description,
      config: row.config,
      enabled: row.enabled,
    }));
    this.cacheLoadedAt = now;

    return this.cachedRules;
  }

  // ─── Rule evaluation ───────────────────────────────────────────────────────

  private async evaluateRule(
    rule: AmlRule,
    input: ScreenTransactionInput,
  ): Promise<RuleEvaluation> {
    switch (rule.ruleType) {
      case "amount_threshold":
        return this.evaluateAmountThreshold(rule, input);
      case "velocity_check":
        return this.evaluateVelocityCheck(rule, input);
      case "blacklisted_phone":
        return this.evaluateBlacklistedPhone(rule, input);
      default:
        // Unknown rule type – do not trigger, just log
        return {
          rule,
          triggered: false,
          details: { error: `Unknown rule type: ${(rule as AmlRule).ruleType}` },
        };
    }
  }

  /**
   * amount_threshold rule
   *
   * config shape:
   *   { "threshold_xaf": number }
   *
   * Triggers when input.amount >= threshold_xaf.
   */
  private evaluateAmountThreshold(
    rule: AmlRule,
    input: ScreenTransactionInput,
  ): RuleEvaluation {
    const threshold = Number(rule.config["threshold_xaf"]);

    if (!Number.isFinite(threshold) || threshold <= 0) {
      return {
        rule,
        triggered: false,
        details: { error: "Invalid threshold_xaf in rule config", config: rule.config },
      };
    }

    const triggered = input.amount >= threshold;

    return {
      rule,
      triggered,
      details: {
        observed_amount: input.amount,
        threshold_xaf: threshold,
      },
    };
  }

  /**
   * velocity_check rule
   *
   * config shape:
   *   { "max_count": number, "window_seconds": number }
   *
   * Uses a Redis INCR counter keyed by phone + window.
   * Triggers when the current count (before this transaction) >= max_count,
   * meaning this transaction would be the (max_count + 1)th.
   *
   * Falls back gracefully if Redis is unavailable.
   */
  private async evaluateVelocityCheck(
    rule: AmlRule,
    input: ScreenTransactionInput,
  ): Promise<RuleEvaluation> {
    const maxCount = Number(rule.config["max_count"]);
    const windowSeconds = Number(rule.config["window_seconds"]);

    if (!Number.isFinite(maxCount) || !Number.isFinite(windowSeconds)
        || maxCount <= 0 || windowSeconds <= 0) {
      return {
        rule,
        triggered: false,
        details: { error: "Invalid velocity rule config", config: rule.config },
      };
    }

    const key = this.velocityKey(input.phoneNumber, windowSeconds);

    let currentCount = 0;
    try {
      const raw = await redisClient.get(key);
      currentCount = raw ? parseInt(raw, 10) : 0;
      if (!Number.isFinite(currentCount)) currentCount = 0;
    } catch (err) {
      // Redis unavailable – fail open (don't block transactions)
      console.error(`[AmlScreening] Redis GET failed for velocity key ${key}:`, err);
      return {
        rule,
        triggered: false,
        details: {
          error: "Redis unavailable; velocity check skipped",
          phone: input.phoneNumber,
          window_seconds: windowSeconds,
          max_count: maxCount,
        },
      };
    }

    // Trigger if the existing count (before adding this transaction) >= max_count.
    const triggered = currentCount >= maxCount;

    return {
      rule,
      triggered,
      details: {
        phone_number: input.phoneNumber,
        current_count: currentCount,
        max_count: maxCount,
        window_seconds: windowSeconds,
        redis_key: key,
      },
    };
  }

  /**
   * blacklisted_phone rule
   *
   * config shape:
   *   { "numbers": string[] }
   *
   * Normalises numbers to E.164 before comparison.
   */
  private evaluateBlacklistedPhone(
    rule: AmlRule,
    input: ScreenTransactionInput,
  ): RuleEvaluation {
    const numbers: unknown = rule.config["numbers"];

    if (!Array.isArray(numbers)) {
      return {
        rule,
        triggered: false,
        details: { error: "Invalid blacklist config – 'numbers' must be an array" },
      };
    }

    const normalised = normalisePhone(input.phoneNumber);
    const blacklist: string[] = (numbers as unknown[])
      .filter((n): n is string => typeof n === "string")
      .map(normalisePhone);

    const triggered = blacklist.includes(normalised);

    return {
      rule,
      triggered,
      details: {
        phone_number: input.phoneNumber,
        matched: triggered,
      },
    };
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  private async persistResults(
    transactionId: string,
    evaluations: RuleEvaluation[],
  ): Promise<void> {
    const inputs: CreateAmlScreeningResultInput[] = evaluations.map((e) => ({
      transactionId,
      ruleId: e.rule.id,
      ruleName: e.rule.name,
      ruleType: e.rule.ruleType,
      triggered: e.triggered,
      details: e.details,
    }));

    await this.resultModel.createBulk(inputs);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private velocityKey(phoneNumber: string, windowSeconds: number): string {
    // Normalise the phone so "+237 600 000 000" and "+237600000000" map to the same key
    const normalised = normalisePhone(phoneNumber);
    // Round window to an absolute time bucket so all service instances share the same key
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    return `${VELOCITY_KEY_PREFIX}${normalised}:${windowSeconds}:${bucket}`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip non-digit characters (except leading +) for consistent key comparison. */
function normalisePhone(phone: string): string {
  return phone.replace(/[^+\d]/g, "");
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const amlScreeningService = new AmlScreeningService();
