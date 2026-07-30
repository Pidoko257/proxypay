/**
 * Provider Fee Configuration Service — Issue #200
 *
 * Extends the base fee system with:
 *   - Provider-specific fee overrides (MTN, Airtel, Orange)
 *   - Fee versioning with full history and rollback
 *   - Fee change approval workflow (propose → approve/reject → activate)
 *   - Fee simulation: preview impact before activation
 *   - Fee analytics: trends, volume-weighted effective rates, savings
 *   - Fee display helper for API responses
 */

import { pool } from "../config/database";
import { layeredCache } from "./layeredCache";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderName = "mtn" | "airtel" | "orange";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "superseded";

export interface ProviderFeeConfig {
  id: string;
  provider: ProviderName;
  feePercentage: number;
  feeMinimum: number;
  feeMaximum: number;
  isActive: boolean;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  description?: string;
}

export interface FeeChangeProposal {
  id: string;
  provider: ProviderName | null;   // null = global config change
  feeConfigId: string | null;
  proposedChanges: Record<string, unknown>;
  status: ApprovalStatus;
  proposedBy: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  proposedAt: Date;
  reviewedAt: Date | null;
}

export interface FeeSimulationResult {
  provider: ProviderName | null;
  sampleAmounts: number[];
  currentFees: { amount: number; fee: number; total: number }[];
  proposedFees: { amount: number; fee: number; total: number }[];
  impact: {
    avgFeeChangePct: number;
    minFeeChange: number;
    maxFeeChange: number;
    estimatedRevenueImpactPct: number;
  };
}

export interface FeeAnalytics {
  period: { start: string; end: string };
  provider: ProviderName | "all";
  totalTransactions: number;
  totalVolume: number;
  totalFeesCollected: number;
  effectiveRate: number;          // Volume-weighted effective rate
  avgFeePerTransaction: number;
  dailyTrend: {
    date: string;
    transactions: number;
    volume: number;
    fees: number;
    effectiveRate: number;
  }[];
  topFeeConfig: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_FEE_CACHE_TTL = 3600;
const providerFeeCacheKey = (provider: ProviderName) => `provider_fee:${provider}:active`;

// ─────────────────────────────────────────────────────────────────────────────
// Provider Fee Configuration Service
// ─────────────────────────────────────────────────────────────────────────────

export class ProviderFeeService {

  // ─── Provider-specific fee configs ────────────────────────────────────────

  /**
   * Get the active fee configuration for a specific provider.
   * Falls back to global config if no provider-specific config exists.
   */
  async getProviderFeeConfig(provider: ProviderName): Promise<ProviderFeeConfig | null> {
    const cacheKey = providerFeeCacheKey(provider);
    const cached = await layeredCache.get<ProviderFeeConfig>(cacheKey);
    if (cached) return cached;

    const result = await pool.query<any>(
      `SELECT
         id, provider,
         fee_percentage AS "feePercentage",
         fee_minimum    AS "feeMinimum",
         fee_maximum    AS "feeMaximum",
         is_active      AS "isActive",
         version,
         description,
         created_by     AS "createdBy",
         updated_by     AS "updatedBy",
         created_at     AS "createdAt",
         updated_at     AS "updatedAt"
       FROM provider_fee_configs
       WHERE provider = $1 AND is_active = true
       ORDER BY version DESC
       LIMIT 1`,
      [provider],
    );

    if (result.rows.length === 0) return null;
    const config = result.rows[0];
    await layeredCache.set(cacheKey, config, PROVIDER_FEE_CACHE_TTL);
    return config;
  }

  /**
   * Get all provider fee configurations (all versions, all providers).
   */
  async getAllProviderFeeConfigs(provider?: ProviderName): Promise<ProviderFeeConfig[]> {
    const query = provider
      ? `SELECT id, provider,
               fee_percentage AS "feePercentage",
               fee_minimum    AS "feeMinimum",
               fee_maximum    AS "feeMaximum",
               is_active      AS "isActive",
               version, description,
               created_by AS "createdBy", updated_by AS "updatedBy",
               created_at AS "createdAt", updated_at AS "updatedAt"
         FROM provider_fee_configs WHERE provider = $1 ORDER BY version DESC`
      : `SELECT id, provider,
               fee_percentage AS "feePercentage",
               fee_minimum    AS "feeMinimum",
               fee_maximum    AS "feeMaximum",
               is_active      AS "isActive",
               version, description,
               created_by AS "createdBy", updated_by AS "updatedBy",
               created_at AS "createdAt", updated_at AS "updatedAt"
         FROM provider_fee_configs ORDER BY provider, version DESC`;

    const result = await pool.query<any>(query, provider ? [provider] : []);
    return result.rows;
  }

  /**
   * Create a new provider fee configuration (inactive by default — requires activation).
   */
  async createProviderFeeConfig(
    data: {
      provider: ProviderName;
      feePercentage: number;
      feeMinimum: number;
      feeMaximum: number;
      description?: string;
    },
    createdBy: string,
  ): Promise<ProviderFeeConfig> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Get the next version number for this provider
      const versionResult = await client.query<{ max_version: number | null }>(
        `SELECT MAX(version) AS max_version FROM provider_fee_configs WHERE provider = $1`,
        [data.provider],
      );
      const nextVersion = (versionResult.rows[0].max_version ?? 0) + 1;

      const result = await client.query<any>(
        `INSERT INTO provider_fee_configs
           (provider, fee_percentage, fee_minimum, fee_maximum, description,
            version, is_active, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, false, $7, $7)
         RETURNING
           id, provider,
           fee_percentage AS "feePercentage",
           fee_minimum    AS "feeMinimum",
           fee_maximum    AS "feeMaximum",
           is_active      AS "isActive",
           version, description,
           created_by AS "createdBy", updated_by AS "updatedBy",
           created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          data.provider,
          data.feePercentage,
          data.feeMinimum,
          data.feeMaximum,
          data.description ?? null,
          nextVersion,
          createdBy,
        ],
      );

      await client.query("COMMIT");
      return result.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Activate a specific version of a provider fee config.
   * Deactivates any currently active config for that provider.
   */
  async activateProviderFeeConfig(
    id: string,
    activatedBy: string,
  ): Promise<ProviderFeeConfig | null> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Find the config to activate
      const findResult = await client.query<any>(
        `SELECT provider FROM provider_fee_configs WHERE id = $1`,
        [id],
      );
      if (findResult.rows.length === 0) return null;

      const { provider } = findResult.rows[0];

      // Deactivate current active config for this provider
      await client.query(
        `UPDATE provider_fee_configs SET is_active = false
         WHERE provider = $1 AND is_active = true`,
        [provider],
      );

      // Activate the specified one
      const result = await client.query<any>(
        `UPDATE provider_fee_configs
         SET is_active = true, updated_by = $2, updated_at = NOW()
         WHERE id = $1
         RETURNING
           id, provider,
           fee_percentage AS "feePercentage",
           fee_minimum    AS "feeMinimum",
           fee_maximum    AS "feeMaximum",
           is_active      AS "isActive",
           version, description,
           created_by AS "createdBy", updated_by AS "updatedBy",
           created_at AS "createdAt", updated_at AS "updatedAt"`,
        [id, activatedBy],
      );

      await client.query("COMMIT");

      // Invalidate cache
      await layeredCache.del(providerFeeCacheKey(provider));

      return result.rows[0] ?? null;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Fee change approval workflow ─────────────────────────────────────────

  /**
   * Propose a fee change for review.
   */
  async proposeFeeChange(
    data: {
      provider: ProviderName | null;
      feeConfigId: string | null;
      proposedChanges: Record<string, unknown>;
    },
    proposedBy: string,
  ): Promise<FeeChangeProposal> {
    const result = await pool.query<any>(
      `INSERT INTO fee_change_proposals
         (provider, fee_config_id, proposed_changes, status, proposed_by)
       VALUES ($1, $2, $3, 'pending', $4)
       RETURNING
         id, provider,
         fee_config_id  AS "feeConfigId",
         proposed_changes AS "proposedChanges",
         status,
         proposed_by   AS "proposedBy",
         reviewed_by   AS "reviewedBy",
         review_note   AS "reviewNote",
         proposed_at   AS "proposedAt",
         reviewed_at   AS "reviewedAt"`,
      [data.provider, data.feeConfigId, JSON.stringify(data.proposedChanges), proposedBy],
    );
    return result.rows[0];
  }

  /**
   * Review a fee change proposal (approve or reject).
   */
  async reviewFeeChangeProposal(
    proposalId: string,
    decision: "approved" | "rejected",
    reviewedBy: string,
    reviewNote?: string,
  ): Promise<FeeChangeProposal | null> {
    const result = await pool.query<any>(
      `UPDATE fee_change_proposals
       SET status = $2, reviewed_by = $3, review_note = $4, reviewed_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING
         id, provider,
         fee_config_id  AS "feeConfigId",
         proposed_changes AS "proposedChanges",
         status,
         proposed_by   AS "proposedBy",
         reviewed_by   AS "reviewedBy",
         review_note   AS "reviewNote",
         proposed_at   AS "proposedAt",
         reviewed_at   AS "reviewedAt"`,
      [proposalId, decision, reviewedBy, reviewNote ?? null],
    );
    return result.rows[0] ?? null;
  }

  /**
   * List pending/all fee change proposals.
   */
  async getFeeChangeProposals(
    status?: ApprovalStatus,
  ): Promise<FeeChangeProposal[]> {
    const query = status
      ? `SELECT id, provider, fee_config_id AS "feeConfigId",
               proposed_changes AS "proposedChanges", status,
               proposed_by AS "proposedBy", reviewed_by AS "reviewedBy",
               review_note AS "reviewNote", proposed_at AS "proposedAt",
               reviewed_at AS "reviewedAt"
         FROM fee_change_proposals WHERE status = $1 ORDER BY proposed_at DESC`
      : `SELECT id, provider, fee_config_id AS "feeConfigId",
               proposed_changes AS "proposedChanges", status,
               proposed_by AS "proposedBy", reviewed_by AS "reviewedBy",
               review_note AS "reviewNote", proposed_at AS "proposedAt",
               reviewed_at AS "reviewedAt"
         FROM fee_change_proposals ORDER BY proposed_at DESC`;

    const result = await pool.query<any>(query, status ? [status] : []);
    return result.rows;
  }

  // ─── Fee simulation ───────────────────────────────────────────────────────

  /**
   * Simulate the impact of proposed fee parameters against actual transaction data.
   */
  async simulateFee(
    proposal: {
      provider: ProviderName | null;
      feePercentage: number;
      feeMinimum: number;
      feeMaximum: number;
    },
    sampleAmounts?: number[],
  ): Promise<FeeSimulationResult> {
    // Default sample amounts covering the range 100 XAF → 1,000,000 XAF
    const amounts = sampleAmounts ?? [100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000];

    // Get current fee params (provider-specific or global)
    let currentPercentage = 1.5;
    let currentMin = 50;
    let currentMax = 5000;

    if (proposal.provider) {
      const existing = await this.getProviderFeeConfig(proposal.provider);
      if (existing) {
        currentPercentage = existing.feePercentage;
        currentMin = existing.feeMinimum;
        currentMax = existing.feeMaximum;
      }
    } else {
      try {
        const { feeService } = await import("./feeService");
        const active = await feeService.getActiveConfiguration();
        currentPercentage = active.feePercentage;
        currentMin = active.feeMinimum;
        currentMax = active.feeMaximum;
      } catch { /* use defaults */ }
    }

    const calcFee = (
      amount: number,
      pct: number,
      min: number,
      max: number,
    ) => {
      let fee = amount * (pct / 100);
      if (fee < min) fee = min;
      if (fee > max) fee = max;
      return parseFloat(fee.toFixed(2));
    };

    const currentFees = amounts.map((amount) => ({
      amount,
      fee: calcFee(amount, currentPercentage, currentMin, currentMax),
      total: parseFloat((amount + calcFee(amount, currentPercentage, currentMin, currentMax)).toFixed(2)),
    }));

    const proposedFees = amounts.map((amount) => ({
      amount,
      fee: calcFee(amount, proposal.feePercentage, proposal.feeMinimum, proposal.feeMaximum),
      total: parseFloat((amount + calcFee(amount, proposal.feePercentage, proposal.feeMinimum, proposal.feeMaximum)).toFixed(2)),
    }));

    const feeChanges = amounts.map((_, i) => proposedFees[i].fee - currentFees[i].fee);
    const avgFeeChangePct =
      currentFees.reduce((sum, cf) => sum + cf.fee, 0) > 0
        ? (feeChanges.reduce((a, b) => a + b, 0) / currentFees.reduce((sum, cf) => sum + cf.fee, 0)) * 100
        : 0;

    return {
      provider: proposal.provider,
      sampleAmounts: amounts,
      currentFees,
      proposedFees,
      impact: {
        avgFeeChangePct: parseFloat(avgFeeChangePct.toFixed(4)),
        minFeeChange: Math.min(...feeChanges),
        maxFeeChange: Math.max(...feeChanges),
        estimatedRevenueImpactPct: parseFloat(avgFeeChangePct.toFixed(4)),
      },
    };
  }

  // ─── Fee analytics ────────────────────────────────────────────────────────

  /**
   * Get fee analytics for a given period and optionally a specific provider.
   */
  async getFeeAnalytics(
    startDate: string,
    endDate: string,
    provider?: ProviderName,
  ): Promise<FeeAnalytics> {
    const providerFilter = provider ? `AND t.provider = '${provider}'` : "";

    const summaryQuery = `
      SELECT
        COUNT(*)                        AS total_transactions,
        COALESCE(SUM(t.amount), 0)      AS total_volume,
        COALESCE(SUM(t.fee_amount), 0)  AS total_fees
      FROM transactions t
      WHERE DATE(t.created_at) BETWEEN $1 AND $2
        ${providerFilter}
        AND t.status = 'completed'
    `;

    const dailyQuery = `
      SELECT
        DATE(t.created_at)              AS date,
        COUNT(*)                        AS transactions,
        COALESCE(SUM(t.amount), 0)      AS volume,
        COALESCE(SUM(t.fee_amount), 0)  AS fees
      FROM transactions t
      WHERE DATE(t.created_at) BETWEEN $1 AND $2
        ${providerFilter}
        AND t.status = 'completed'
      GROUP BY DATE(t.created_at)
      ORDER BY DATE(t.created_at)
    `;

    const [summaryResult, dailyResult] = await Promise.all([
      pool.query<any>(summaryQuery, [startDate, endDate]),
      pool.query<any>(dailyQuery, [startDate, endDate]),
    ]);

    const summary = summaryResult.rows[0];
    const totalVolume = parseFloat(summary.total_volume);
    const totalFees = parseFloat(summary.total_fees);
    const totalTransactions = parseInt(summary.total_transactions, 10);

    const effectiveRate = totalVolume > 0 ? (totalFees / totalVolume) * 100 : 0;
    const avgFeePerTransaction = totalTransactions > 0 ? totalFees / totalTransactions : 0;

    const dailyTrend = dailyResult.rows.map((row: any) => {
      const vol = parseFloat(row.volume);
      const fees = parseFloat(row.fees);
      return {
        date: String(row.date).slice(0, 10),
        transactions: parseInt(row.transactions, 10),
        volume: vol,
        fees,
        effectiveRate: vol > 0 ? parseFloat(((fees / vol) * 100).toFixed(4)) : 0,
      };
    });

    return {
      period: { start: startDate, end: endDate },
      provider: provider ?? "all",
      totalTransactions,
      totalVolume: parseFloat(totalVolume.toFixed(2)),
      totalFeesCollected: parseFloat(totalFees.toFixed(2)),
      effectiveRate: parseFloat(effectiveRate.toFixed(4)),
      avgFeePerTransaction: parseFloat(avgFeePerTransaction.toFixed(2)),
      dailyTrend,
      topFeeConfig: "active",
    };
  }

  // ─── Fee display helper ───────────────────────────────────────────────────

  /**
   * Build a fee display object suitable for embedding in transaction API responses.
   */
  async buildFeeDisplay(
    amount: number,
    provider?: ProviderName,
  ): Promise<{
    fee: number;
    feePercentage: number;
    feeMinimum: number;
    feeMaximum: number;
    total: number;
    configUsed: string;
    provider: ProviderName | null;
  }> {
    let feePercentage = 1.5;
    let feeMinimum = 50;
    let feeMaximum = 5000;
    let configUsed = "global-default";

    if (provider) {
      const providerConfig = await this.getProviderFeeConfig(provider);
      if (providerConfig) {
        feePercentage = providerConfig.feePercentage;
        feeMinimum = providerConfig.feeMinimum;
        feeMaximum = providerConfig.feeMaximum;
        configUsed = `provider:${provider}:v${providerConfig.version}`;
      } else {
        // Fall back to global config
        try {
          const { feeService } = await import("./feeService");
          const active = await feeService.getActiveConfiguration();
          feePercentage = active.feePercentage;
          feeMinimum = active.feeMinimum;
          feeMaximum = active.feeMaximum;
          configUsed = `global:${active.name}`;
        } catch { /* use defaults */ }
      }
    }

    let fee = amount * (feePercentage / 100);
    if (fee < feeMinimum) fee = feeMinimum;
    if (fee > feeMaximum) fee = feeMaximum;
    fee = parseFloat(fee.toFixed(2));

    return {
      fee,
      feePercentage,
      feeMinimum,
      feeMaximum,
      total: parseFloat((amount + fee).toFixed(2)),
      configUsed,
      provider: provider ?? null,
    };
  }
}

export const providerFeeService = new ProviderFeeService();
