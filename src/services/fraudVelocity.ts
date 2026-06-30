/**
 * Fraud Detection Velocity Rules Service (Issue #109)
 *
 * Implements three velocity-based fraud detection rules using Redis sorted sets
 * for O(log N) sliding-window counters:
 *
 *  1. multi_destination_velocity  — Same API key sends to >5 different numbers
 *                                   within a 10-minute sliding window.
 *  2. large_payment_concentration — Same destination receives >3 large payments
 *                                   in a 24-hour sliding window.
 *  3. structuring_escalation      — Transaction amounts follow a strictly
 *                                   increasing (structuring) pattern within the
 *                                   last N transactions in a 1-hour window.
 *
 * Rules are configurable via the `fraud_velocity_rules` database table; the
 * active rule set is refreshed on every call so changes take effect without
 * a restart.
 *
 * When a rule fires:
 *   - The transaction status is set to `pending_review`.
 *   - A record is inserted into the `fraud_alerts` table with full context.
 */

import { redisClient } from "../config/redis";
import { queryRead, queryWrite } from "../config/database";
import { TransactionModel, TransactionStatus } from "../models/transaction";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VelocityRuleConfig {
  id: string;
  name: string;
  description: string;
  ruleType:
    | "multi_destination_velocity"
    | "large_payment_concentration"
    | "structuring_escalation";
  windowSeconds: number;
  threshold: number;
  score: number;
  isActive: boolean;
}

export interface VelocityCheckInput {
  transactionId: string;
  userId?: string | null;
  /** API key or user identifier used for velocity grouping */
  apiKey?: string | null;
  amount: number;
  destinationPhone: string;
  /** Threshold above which a payment is considered "large" (default: 500) */
  largPaymentThreshold?: number;
  timestamp: Date;
}

export interface VelocityRuleViolation {
  ruleId: string;
  ruleName: string;
  ruleType: string;
  score: number;
  context: Record<string, unknown>;
}

export interface VelocityCheckResult {
  violated: boolean;
  violations: VelocityRuleViolation[];
  totalScore: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LARGE_PAYMENT_THRESHOLD = 500;

/** Fetch active rules from the database. */
async function loadActiveRules(): Promise<VelocityRuleConfig[]> {
  try {
    const res = await queryRead(
      `SELECT id, name, description, rule_type, window_seconds, threshold, score, is_active
       FROM fraud_velocity_rules
       WHERE is_active = TRUE
       ORDER BY name`,
    );
    return res.rows.map((r: any) => ({
      id: r.id as string,
      name: r.name as string,
      description: r.description as string,
      ruleType: r.rule_type as VelocityRuleConfig["ruleType"],
      windowSeconds: r.window_seconds as number,
      threshold: r.threshold as number,
      score: r.score as number,
      isActive: r.is_active as boolean,
    }));
  } catch (err) {
    console.error("[FraudVelocity] Failed to load rules from DB:", err);
    return [];
  }
}

/**
 * Sliding-window counter backed by a Redis sorted set.
 *
 * The sorted set stores members with the current timestamp as score.  On each
 * call we:
 *  1. Remove members older than the window.
 *  2. Add the new event.
 *  3. Count remaining members.
 *
 * Returns the count AFTER adding the current event.
 */
async function slidingWindowCount(
  key: string,
  windowSeconds: number,
  member: string,
  nowMs: number,
): Promise<number> {
  const windowStartMs = nowMs - windowSeconds * 1000;
  const expireSeconds = windowSeconds + 60; // a little headroom

  try {
    // Atomic Lua script: remove stale, add new, count, set TTL
    const script = `
      local key = KEYS[1]
      local windowStart = tonumber(ARGV[1])
      local now = tonumber(ARGV[2])
      local member = ARGV[3]
      local expire = tonumber(ARGV[4])

      redis.call("ZREMRANGEBYSCORE", key, 0, windowStart)
      redis.call("ZADD", key, now, member)
      local count = redis.call("ZCARD", key)
      redis.call("EXPIRE", key, expire)
      return count
    `;

    const result = await redisClient.sendCommand([
      "EVAL",
      script,
      "1",
      key,
      String(windowStartMs),
      String(nowMs),
      member,
      String(expireSeconds),
    ]) as unknown as number;

    return Number(result);
  } catch (err) {
    console.error("[FraudVelocity] Redis error in slidingWindowCount:", err);
    return 0;
  }
}

/**
 * Count the number of *distinct* destination phone numbers seen from a given
 * API key within the window.
 */
async function countDistinctDestinations(
  apiKey: string,
  destination: string,
  windowSeconds: number,
  nowMs: number,
): Promise<number> {
  const key = `fraud:velocity:destinations:${apiKey}`;
  // Use destination+timestamp as member to allow multiple sends to same number
  // but track them as distinct entries; cardinality of unique phones is inferred
  // via a separate set.
  const uniqueKey = `fraud:velocity:uniq_dest:${apiKey}`;
  const windowStartMs = nowMs - windowSeconds * 1000;
  const expireSeconds = windowSeconds + 60;

  try {
    const script = `
      local tsKey = KEYS[1]
      local uniqKey = KEYS[2]
      local windowStart = tonumber(ARGV[1])
      local now = tonumber(ARGV[2])
      local dest = ARGV[3]
      local expire = tonumber(ARGV[4])

      -- Maintain a sorted set of (timestamp → destination) entries
      redis.call("ZADD", tsKey, now, dest .. ":" .. now)
      redis.call("EXPIRE", tsKey, expire)

      -- Rebuild unique destinations from remaining entries
      redis.call("ZREMRANGEBYSCORE", tsKey, 0, windowStart)
      local entries = redis.call("ZRANGE", tsKey, 0, -1)

      -- Count unique destinations
      local seen = {}
      for _, entry in ipairs(entries) do
        local d = string.match(entry, "^(.*):%-?%d+$") or entry
        -- fallback: split on last colon
        local lastColon = 0
        for i = #entry, 1, -1 do
          if string.sub(entry, i, i) == ":" then lastColon = i break end
        end
        local phone = lastColon > 0 and string.sub(entry, 1, lastColon - 1) or entry
        seen[phone] = true
      end

      local count = 0
      for _ in pairs(seen) do count = count + 1 end
      return count
    `;

    const result = await redisClient.sendCommand([
      "EVAL",
      script,
      "2",
      key,
      uniqueKey,
      String(windowStartMs),
      String(nowMs),
      destination,
      String(expireSeconds),
    ]) as unknown as number;

    return Number(result);
  } catch (err) {
    console.error("[FraudVelocity] Redis error in countDistinctDestinations:", err);
    return 0;
  }
}

/**
 * Count how many times a destination phone received a "large" payment in the
 * sliding window.
 */
async function countLargePaymentsToDestination(
  destination: string,
  amount: number,
  largeThreshold: number,
  windowSeconds: number,
  nowMs: number,
): Promise<number> {
  if (amount < largeThreshold) return 0;

  const key = `fraud:velocity:large_recv:${destination}`;
  const member = `${nowMs}:${Math.random().toString(36).slice(2, 8)}`;
  return slidingWindowCount(key, windowSeconds, member, nowMs);
}

/**
 * Detect structuring: fetch the last N amounts for the given destination in
 * the window and check if they form a strictly increasing sequence.
 */
async function detectStructuring(
  destination: string,
  amount: number,
  windowSeconds: number,
  minSequenceLength: number,
  nowMs: number,
): Promise<boolean> {
  const key = `fraud:velocity:amounts:${destination}`;
  const windowStartMs = nowMs - windowSeconds * 1000;
  const expireSeconds = windowSeconds + 60;
  const member = `${amount}:${nowMs}:${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Add current amount and retrieve all within window (ordered by score = ts)
    const script = `
      local key = KEYS[1]
      local windowStart = tonumber(ARGV[1])
      local now = tonumber(ARGV[2])
      local member = ARGV[3]
      local expire = tonumber(ARGV[4])

      redis.call("ZREMRANGEBYSCORE", key, 0, windowStart)
      redis.call("ZADD", key, now, member)
      redis.call("EXPIRE", key, expire)
      return redis.call("ZRANGE", key, 0, -1, "WITHSCORES")
    `;

    const result = await redisClient.sendCommand([
      "EVAL",
      script,
      "1",
      key,
      String(windowStartMs),
      String(nowMs),
      member,
      String(expireSeconds),
    ]) as unknown as string[];

    if (!Array.isArray(result) || result.length < 2) return false;

    // Parse amounts from "amount:timestamp:random" members, ordered by score
    const amounts: number[] = [];
    for (let i = 0; i < result.length; i += 2) {
      const parts = (result[i] as string).split(":");
      const amt = parseFloat(parts[0]);
      if (!isNaN(amt)) amounts.push(amt);
    }

    if (amounts.length < minSequenceLength) return false;

    // Check the last `minSequenceLength` entries for strictly increasing order
    const tail = amounts.slice(-minSequenceLength);
    for (let i = 1; i < tail.length; i++) {
      if (tail[i] <= tail[i - 1]) return false;
    }
    return true;
  } catch (err) {
    console.error("[FraudVelocity] Redis error in detectStructuring:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Alert persistence
// ---------------------------------------------------------------------------

async function insertFraudAlert(params: {
  transactionId: string;
  userId?: string | null;
  ruleId: string;
  ruleName: string;
  ruleType: string;
  fraudScore: number;
  context: Record<string, unknown>;
}): Promise<void> {
  try {
    await queryWrite(
      `INSERT INTO fraud_alerts
         (transaction_id, user_id, rule_id, rule_name, rule_type, fraud_score, context, status)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'open')`,
      [
        params.transactionId,
        params.userId ?? null,
        params.ruleId,
        params.ruleName,
        params.ruleType,
        params.fraudScore,
        JSON.stringify(params.context),
      ],
    );
  } catch (err) {
    console.error("[FraudVelocity] Failed to insert fraud alert:", err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class FraudVelocityService {
  private readonly transactionModel = new TransactionModel();

  /**
   * Evaluate all active velocity rules for the given transaction input.
   *
   * Violated rules will:
   *  - Insert a `fraud_alerts` record.
   *  - Set the transaction status to `pending_review` (Review).
   *
   * @returns VelocityCheckResult with all violations and cumulative score.
   */
  async checkVelocityRules(input: VelocityCheckInput): Promise<VelocityCheckResult> {
    const rules = await loadActiveRules();
    const violations: VelocityRuleViolation[] = [];
    const nowMs = input.timestamp.getTime();
    const largeThreshold = input.largPaymentThreshold ?? DEFAULT_LARGE_PAYMENT_THRESHOLD;

    for (const rule of rules) {
      let triggered = false;
      let context: Record<string, unknown> = {};

      // ── Rule 1: multi_destination_velocity ───────────────────────────────
      if (rule.ruleType === "multi_destination_velocity") {
        const groupKey = input.apiKey ?? input.userId ?? "anonymous";
        const distinctCount = await countDistinctDestinations(
          groupKey,
          input.destinationPhone,
          rule.windowSeconds,
          nowMs,
        );

        if (distinctCount > rule.threshold) {
          triggered = true;
          context = {
            ruleType: rule.ruleType,
            apiKey: input.apiKey,
            distinctDestinations: distinctCount,
            threshold: rule.threshold,
            windowSeconds: rule.windowSeconds,
          };
        }
      }

      // ── Rule 2: large_payment_concentration ──────────────────────────────
      else if (rule.ruleType === "large_payment_concentration") {
        const count = await countLargePaymentsToDestination(
          input.destinationPhone,
          input.amount,
          largeThreshold,
          rule.windowSeconds,
          nowMs,
        );

        if (count > rule.threshold) {
          triggered = true;
          context = {
            ruleType: rule.ruleType,
            destination: input.destinationPhone,
            largePaymentCount: count,
            threshold: rule.threshold,
            amount: input.amount,
            largePaymentThreshold: largeThreshold,
            windowSeconds: rule.windowSeconds,
          };
        }
      }

      // ── Rule 3: structuring_escalation ───────────────────────────────────
      else if (rule.ruleType === "structuring_escalation") {
        const isStructuring = await detectStructuring(
          input.destinationPhone,
          input.amount,
          rule.windowSeconds,
          rule.threshold,
          nowMs,
        );

        if (isStructuring) {
          triggered = true;
          context = {
            ruleType: rule.ruleType,
            destination: input.destinationPhone,
            amount: input.amount,
            minSequenceLength: rule.threshold,
            windowSeconds: rule.windowSeconds,
          };
        }
      }

      if (triggered) {
        violations.push({
          ruleId: rule.id,
          ruleName: rule.name,
          ruleType: rule.ruleType,
          score: rule.score,
          context,
        });

        // Persist the alert
        await insertFraudAlert({
          transactionId: input.transactionId,
          userId: input.userId,
          ruleId: rule.id,
          ruleName: rule.name,
          ruleType: rule.ruleType,
          fraudScore: rule.score,
          context,
        });
      }
    }

    const totalScore = violations.reduce((sum, v) => sum + v.score, 0);

    // Set transaction to pending_review when any rule fires
    if (violations.length > 0) {
      try {
        await this.transactionModel.updateStatus(
          input.transactionId,
          TransactionStatus.Review,
        );
        console.warn(
          `[FraudVelocity] Transaction ${input.transactionId} set to pending_review. ` +
            `Rules violated: ${violations.map((v) => v.ruleName).join(", ")}`,
        );
      } catch (err) {
        console.error(
          `[FraudVelocity] Failed to set transaction ${input.transactionId} to review:`,
          err,
        );
      }
    }

    return {
      violated: violations.length > 0,
      violations,
      totalScore,
    };
  }
}

// Singleton instance for use across the application
export const fraudVelocityService = new FraudVelocityService();
