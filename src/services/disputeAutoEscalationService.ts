/**
 * DisputeAutoEscalationService — Automatic escalation rules for disputes
 *
 * Defines and applies automatic escalation rules based on:
 *  - Transaction amount (high-value disputes escalate faster)
 *  - Dispute age (older disputes escalate to higher priority)
 *
 * Rules are configurable in the database or environment, and evaluated
 * periodically by the DisputeSlaJob.
 */

import { pool, queryRead, queryWrite } from "../config/database";
import { Dispute, DisputePriority } from "../models/dispute";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoEscalationRule {
  id: string;
  name: string;
  enabled: boolean;
  minAmount?: number; // Minimum transaction amount (XAF)
  maxAmount?: number; // Maximum transaction amount (XAF), null = no upper limit
  ageHoursThreshold: number; // Escalate if dispute age >= this
  currentPriority?: DisputePriority; // Only escalate if current priority matches
  newPriority: DisputePriority; // Priority to escalate to
  maxEscalationsPerDispute: number; // Prevent infinite escalations
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EscalationEvaluation {
  disputeId: string;
  transactionAmount: number;
  disputeAgeHours: number;
  currentPriority: DisputePriority;
  matchingRules: AutoEscalationRule[];
  shouldEscalate: boolean;
  recommendedPriority?: DisputePriority;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DisputeAutoEscalationService {
  private rulesCache: AutoEscalationRule[] | null = null;
  private rulesCacheExpiry: number = 0;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Load and cache auto-escalation rules from the database.
   */
  private async loadRules(forceRefresh = false): Promise<AutoEscalationRule[]> {
    const now = Date.now();

    // Return cached rules if still valid
    if (
      !forceRefresh &&
      this.rulesCache &&
      now < this.rulesCacheExpiry
    ) {
      return this.rulesCache;
    }

    try {
      const result = await queryRead(
        `
        SELECT
          id, name, enabled, min_amount, max_amount, age_hours_threshold,
          current_priority, new_priority, max_escalations_per_dispute,
          description, created_at, updated_at
        FROM dispute_auto_escalation_rules
        WHERE enabled = TRUE
        ORDER BY age_hours_threshold ASC, COALESCE(min_amount, 0) DESC
      `,
      );

      const rules: AutoEscalationRule[] = result.rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        minAmount: row.min_amount,
        maxAmount: row.max_amount,
        ageHoursThreshold: parseFloat(row.age_hours_threshold),
        currentPriority: row.current_priority || undefined,
        newPriority: row.new_priority,
        maxEscalationsPerDispute: row.max_escalations_per_dispute,
        description: row.description,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }));

      this.rulesCache = rules;
      this.rulesCacheExpiry = now + this.CACHE_TTL_MS;

      return rules;
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "Failed to load auto-escalation rules",
      );
      // Return empty rules array on failure
      return [];
    }
  }

  /**
   * Invalidate the rules cache (call after creating/updating rules).
   */
  async invalidateCache(): Promise<void> {
    this.rulesCache = null;
    this.rulesCacheExpiry = 0;
  }

  /**
   * Evaluate whether a dispute matches any auto-escalation rules.
   * Returns the recommended priority if any rules match.
   */
  async evaluateDispute(
    dispute: Dispute,
    transactionAmount: number,
  ): Promise<EscalationEvaluation> {
    const rules = await this.loadRules();

    // Calculate dispute age in hours
    const now = new Date();
    const ageMs = now.getTime() - dispute.createdAt.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    // Count how many times this dispute has been auto-escalated
    const escalationCount = await this.getEscalationCount(dispute.id);

    // Find matching rules
    const matchingRules = rules.filter((rule) => {
      // Check if rule is enabled
      if (!rule.enabled) return false;

      // Check amount range
      if (rule.minAmount && transactionAmount < rule.minAmount) return false;
      if (rule.maxAmount && transactionAmount > rule.maxAmount) return false;

      // Check age threshold
      if (ageHours < rule.ageHoursThreshold) return false;

      // Check current priority (if specified)
      if (
        rule.currentPriority &&
        dispute.priority !== rule.currentPriority
      ) {
        return false;
      }

      // Check max escalations
      if (escalationCount >= rule.maxEscalationsPerDispute) return false;

      return true;
    });

    // If multiple rules match, use the one with highest new priority
    let recommendedPriority: DisputePriority | undefined;
    if (matchingRules.length > 0) {
      const priorityOrder: Record<DisputePriority, number> = {
        low: 1,
        medium: 2,
        high: 3,
        critical: 4,
      };

      recommendedPriority = matchingRules.reduce((highest, rule) => {
        const currentScore = priorityOrder[highest];
        const ruleScore = priorityOrder[rule.newPriority];
        return ruleScore > currentScore ? rule.newPriority : highest;
      }, matchingRules[0].newPriority);
    }

    const shouldEscalate = matchingRules.length > 0;

    return {
      disputeId: dispute.id,
      transactionAmount,
      disputeAgeHours: ageHours,
      currentPriority: dispute.priority,
      matchingRules,
      shouldEscalate,
      recommendedPriority,
      reason: shouldEscalate
        ? `Matched ${matchingRules.length} escalation rule(s): ${matchingRules.map((r) => r.name).join(", ")}`
        : "No escalation rules matched",
    };
  }

  /**
   * Count how many times a dispute has been auto-escalated.
   */
  private async getEscalationCount(disputeId: string): Promise<number> {
    try {
      const result = await queryRead(
        `
        SELECT COUNT(*) as count
        FROM dispute_auto_escalation_history
        WHERE dispute_id = $1
      `,
        [disputeId],
      );
      return parseInt(result.rows[0].count || "0", 10);
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err), disputeId },
        "Failed to count escalations",
      );
      return 0;
    }
  }

  /**
   * Record an auto-escalation event in the history table.
   */
  async recordAutoEscalation(
    disputeId: string,
    ruleId: string,
    oldPriority: DisputePriority,
    newPriority: DisputePriority,
    transactionAmount: number,
    ageHours: number,
  ): Promise<void> {
    try {
      await queryWrite(
        `
        INSERT INTO dispute_auto_escalation_history
          (dispute_id, rule_id, old_priority, new_priority, transaction_amount, age_hours, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `,
        [disputeId, ruleId, oldPriority, newPriority, transactionAmount, ageHours],
      );
    } catch (err) {
      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
          disputeId,
          ruleId,
        },
        "Failed to record auto-escalation",
      );
    }
  }

  /**
   * Get the auto-escalation history for a dispute.
   */
  async getAutoEscalationHistory(disputeId: string): Promise<any[]> {
    try {
      const result = await queryRead(
        `
        SELECT
          id, dispute_id, rule_id, old_priority, new_priority,
          transaction_amount, age_hours, created_at
        FROM dispute_auto_escalation_history
        WHERE dispute_id = $1
        ORDER BY created_at DESC
      `,
        [disputeId],
      );
      return result.rows;
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err), disputeId },
        "Failed to fetch auto-escalation history",
      );
      return [];
    }
  }

  /**
   * Create a new auto-escalation rule.
   */
  async createRule(rule: Omit<AutoEscalationRule, "id" | "createdAt" | "updatedAt">): Promise<AutoEscalationRule> {
    try {
      const result = await queryWrite(
        `
        INSERT INTO dispute_auto_escalation_rules
          (name, enabled, min_amount, max_amount, age_hours_threshold,
           current_priority, new_priority, max_escalations_per_dispute, description, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
        RETURNING id, name, enabled, min_amount, max_amount, age_hours_threshold,
                  current_priority, new_priority, max_escalations_per_dispute,
                  description, created_at, updated_at
      `,
        [
          rule.name,
          rule.enabled,
          rule.minAmount || null,
          rule.maxAmount || null,
          rule.ageHoursThreshold,
          rule.currentPriority || null,
          rule.newPriority,
          rule.maxEscalationsPerDispute,
          rule.description,
        ],
      );

      const row = result.rows[0];
      await this.invalidateCache();

      return {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        minAmount: row.min_amount,
        maxAmount: row.max_amount,
        ageHoursThreshold: parseFloat(row.age_hours_threshold),
        currentPriority: row.current_priority || undefined,
        newPriority: row.new_priority,
        maxEscalationsPerDispute: row.max_escalations_per_dispute,
        description: row.description,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      };
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "Failed to create auto-escalation rule",
      );
      throw err;
    }
  }

  /**
   * Get all auto-escalation rules (ignoring cache).
   */
  async getAllRules(): Promise<AutoEscalationRule[]> {
    return this.loadRules(true);
  }

  /**
   * Update an auto-escalation rule.
   */
  async updateRule(
    id: string,
    updates: Partial<Omit<AutoEscalationRule, "id" | "createdAt" | "updatedAt">>,
  ): Promise<AutoEscalationRule> {
    const updates_obj: Record<string, any> = {};
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      updates_obj["name"] = `$${paramIndex}`;
      values.push(updates.name);
      paramIndex++;
    }
    if (updates.enabled !== undefined) {
      updates_obj["enabled"] = `$${paramIndex}`;
      values.push(updates.enabled);
      paramIndex++;
    }
    if (updates.minAmount !== undefined) {
      updates_obj["min_amount"] = `$${paramIndex}`;
      values.push(updates.minAmount || null);
      paramIndex++;
    }
    if (updates.maxAmount !== undefined) {
      updates_obj["max_amount"] = `$${paramIndex}`;
      values.push(updates.maxAmount || null);
      paramIndex++;
    }
    if (updates.ageHoursThreshold !== undefined) {
      updates_obj["age_hours_threshold"] = `$${paramIndex}`;
      values.push(updates.ageHoursThreshold);
      paramIndex++;
    }
    if (updates.currentPriority !== undefined) {
      updates_obj["current_priority"] = `$${paramIndex}`;
      values.push(updates.currentPriority || null);
      paramIndex++;
    }
    if (updates.newPriority !== undefined) {
      updates_obj["new_priority"] = `$${paramIndex}`;
      values.push(updates.newPriority);
      paramIndex++;
    }
    if (updates.maxEscalationsPerDispute !== undefined) {
      updates_obj["max_escalations_per_dispute"] = `$${paramIndex}`;
      values.push(updates.maxEscalationsPerDispute);
      paramIndex++;
    }
    if (updates.description !== undefined) {
      updates_obj["description"] = `$${paramIndex}`;
      values.push(updates.description);
      paramIndex++;
    }

    updates_obj["updated_at"] = `$${paramIndex}`;
    values.push(new Date());
    paramIndex++;

    values.push(id);

    const setClause = Object.entries(updates_obj)
      .map(([key, value]) => `${key} = ${value}`)
      .join(", ");

    try {
      const result = await queryWrite(
        `
        UPDATE dispute_auto_escalation_rules
        SET ${setClause}
        WHERE id = $${paramIndex}
        RETURNING id, name, enabled, min_amount, max_amount, age_hours_threshold,
                  current_priority, new_priority, max_escalations_per_dispute,
                  description, created_at, updated_at
      `,
        values,
      );

      const row = result.rows[0];
      await this.invalidateCache();

      return {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        minAmount: row.min_amount,
        maxAmount: row.max_amount,
        ageHoursThreshold: parseFloat(row.age_hours_threshold),
        currentPriority: row.current_priority || undefined,
        newPriority: row.new_priority,
        maxEscalationsPerDispute: row.max_escalations_per_dispute,
        description: row.description,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      };
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err), id },
        "Failed to update auto-escalation rule",
      );
      throw err;
    }
  }

  /**
   * Delete an auto-escalation rule.
   */
  async deleteRule(id: string): Promise<void> {
    try {
      await queryWrite(
        `DELETE FROM dispute_auto_escalation_rules WHERE id = $1`,
        [id],
      );
      await this.invalidateCache();
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err), id },
        "Failed to delete auto-escalation rule",
      );
      throw err;
    }
  }
}
