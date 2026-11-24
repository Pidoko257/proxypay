/**
 * #650 – Admin dashboard query performance
 *
 * The admin dashboard is a set of aggregate queries over the largest tables in
 * the schema (`transactions`, `disputes`, `audit_logs`,
 * `daily_pnl_snapshots`). As those tables grow the dashboard degrades, and the
 * cause is rarely obvious from the application side: the queries are
 * individually well formed, they are just not backed by the right index for
 * the access pattern.
 *
 * This service makes that visible and actionable:
 *
 *   1. `explainDashboardQueries()` runs `EXPLAIN (FORMAT JSON)` for each
 *      registered dashboard query and records the plan cost.
 *   2. `recommendMissingIndexes()` walks those plans and derives concrete
 *      `CREATE INDEX CONCURRENTLY` statements for every sequential scan that
 *      filters on a column. The recommendation is derived from the plan the
 *      planner actually chose, not from a guess at the schema.
 *   3. `collectQueryPerformanceMetrics()` samples table/index statistics so an
 *      operator can see seq-scan ratios and unused indexes over time.
 *
 * Everything is best-effort and read-only: failing to analyse the dashboard
 * must never take the dashboard itself down. Deliberately avoids
 * `pg_stat_statements`, which requires an extension that is not guaranteed to
 * be installed — the same reasoning as migration 20260907.
 */

import { queryRead } from "../config/database";
import logger from "../utils/logger";
import {
  DatabaseOptimizationService,
  type CachedQueryPlan,
} from "./databaseOptimizationService";

/** A dashboard query that is analysed for plan cost and index usage. */
export interface DashboardQuery {
  /** Stable identifier used in reports and in the plan cache. */
  name: string;
  /** The route that issues the query, for operator context. */
  route: string;
  /** Human-readable purpose. */
  description: string;
  /** Parameterised SQL. `EXPLAIN` is run with a representative sample. */
  sql: string;
  /**
   * Representative parameters. The planner produces the same shape with any
   * values, but a non-empty set yields a plan closer to the real one.
   */
  params?: unknown[];
}

/**
 * The dashboard queries worth watching. Kept in one place so a new dashboard
 * widget is analysed the day it is added rather than after it starts hurting.
 */
export const DASHBOARD_QUERIES: readonly DashboardQuery[] = [
  {
    name: "financial_pnl_30d",
    route: "GET /api/admin/financial/pnl",
    description:
      "Daily PnL snapshots for the last 30 days on the financial dashboard",
    sql: `SELECT report_date, user_fees, provider_fees, pnl
            FROM daily_pnl_snapshots
           WHERE report_date >= CURRENT_DATE - INTERVAL '29 days'
           ORDER BY report_date ASC`,
  },
  {
    name: "transactions_reference_search",
    route: "GET /api/admin/transactions?reference=…",
    description:
      "Reference-number lookup backing the dashboard transaction search box",
    sql: `SELECT id
            FROM transactions
           WHERE reference_number = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`,
    params: ["PR-000000", 50],
  },
  {
    name: "transactions_status_created",
    route: "GET /api/admin/transactions",
    description:
      "Recent-transactions list, ordered by creation time with a status filter",
    sql: `SELECT id
            FROM transactions
           WHERE status = ANY($1::text[])
           ORDER BY created_at DESC, id DESC
           LIMIT $2`,
    params: [["completed", "pending"], 50],
  },
  {
    name: "transactions_volume_24h",
    route: "GET /api/admin/dashboard/stats",
    description:
      "24-hour transaction volume and success-rate aggregate on the dashboard",
    sql: `SELECT COUNT(*)::int                    AS total,
                 COALESCE(SUM(amount), 0)::text    AS volume,
                 COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
            FROM transactions
           WHERE created_at >= $1`,
    params: ["2026-01-01T00:00:00.000Z"],
  },
  {
    name: "disputes_open_by_transaction",
    route: "GET /api/admin/disputes",
    description:
      "Open-dispute queue joined back to the originating transaction",
    sql: `SELECT d.id
            FROM disputes d
            JOIN transactions t ON t.id = d.transaction_id
           WHERE d.status = ANY($1::text[])
           ORDER BY d.created_at DESC
           LIMIT $2`,
    params: [["open", "under_review"], 50],
  },
] as const;

/** A single node of an `EXPLAIN (FORMAT JSON)` plan tree. */
export interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Filter?: string;
  "Plan Cost"?: number;
  "Total Cost"?: number;
  "Actual Rows"?: number;
  Plans?: PlanNode[];
}

/** Result of analysing one dashboard query. */
export interface DashboardQueryAnalysis {
  name: string;
  route: string;
  description: string;
  /** Total cost the planner assigned, or null when it could not be read. */
  planCost: number | null;
  /** Wall-clock duration of the EXPLAIN round-trip, in milliseconds. */
  analyzeDurationMs: number;
  /** Indexes the plan actually chose to use. */
  indexesUsed: string[];
  /** Relations reached by a sequential scan. */
  seqScannedTables: string[];
  /** True when the planner reported a cost above the configured budget. */
  overBudget: boolean;
  /** Plan cache entry, used to detect plan regressions between runs. */
  cachedPlan?: CachedQueryPlan;
  error?: string;
}

/** A derived, ready-to-run index recommendation. */
export interface IndexRecommendation {
  table: string;
  columns: string[];
  /** The `CREATE INDEX CONCURRENTLY` statement to apply. */
  createStatement: string;
  /** Why the planner wants this index, in operator terms. */
  reason: string;
  /** Query whose plan produced the recommendation. */
  sourceQuery: string;
  /** Estimated cost of the sequential scan being replaced. */
  estimatedCost: number | null;
}

/** Per-table statistics sampled for performance monitoring. */
export interface QueryPerformanceMetric {
  table: string;
  seqScans: number;
  seqTuplesRead: number;
  indexScans: number;
  liveTuples: number;
  deadTuples: number;
  lastSeqScan: Date | null;
  unusedIndexes: number;
  /** Share of accesses that used a sequential scan (0–1). */
  seqScanRatio: number;
}

/** Tables the dashboard reads most heavily, monitored by default. */
export const DEFAULT_MONITORED_TABLES = [
  "transactions",
  "disputes",
  "daily_pnl_snapshots",
  "audit_logs",
  "users",
];

export interface QueryPerformanceConfig {
  /**
   * Planner cost above which a dashboard query is considered over budget.
   * PostgreSQL costs are unitless and relative, not milliseconds; 1000 is
   * roughly "scanning a small table repeatedly".
   */
  planCostBudget: number;
  /** Minimum cost of a sequential scan before an index is recommended. */
  minSeqScanCost: number;
}

const DEFAULTS: QueryPerformanceConfig = {
  planCostBudget: Number(process.env.DASHBOARD_QUERY_COST_BUDGET ?? 1000),
  minSeqScanCost: Number(
    process.env.DASHBOARD_INDEX_MIN_SEQ_SCAN_COST ?? 100,
  ),
};

/** A flattened sequential-scan node with its filter and cost. */
interface SeqScanInfo {
  relation: string;
  filter?: string;
  cost?: number;
}

export class AdminDashboardQueryPerformanceService {
  constructor(private readonly config: QueryPerformanceConfig = DEFAULTS) {}

  /**
   * Runs `EXPLAIN (FORMAT JSON)` for every registered dashboard query and
   * caches the resulting plan via the shared query-plan cache, so a later
   * regression (same query, materially higher cost) becomes detectable.
   *
   * A query that fails to analyse is reported with its error rather than
   * aborting the run.
   */
  async explainDashboardQueries(
    queries: readonly DashboardQuery[] = DASHBOARD_QUERIES,
  ): Promise<DashboardQueryAnalysis[]> {
    const results: DashboardQueryAnalysis[] = [];

    for (const query of queries) {
      const startedAt = Date.now();
      try {
        const plan = await this.explain(query);
        const planCost = readPlanCost(plan);
        const indexesUsed = this.collectIndexesUsed(plan);
        const seqScannedTables = this.collectSeqScannedTables(plan);

        // Cache for regression detection. A cache failure must not lose the
        // analysis we just performed, so it is logged and swallowed.
        let cachedPlan: CachedQueryPlan | undefined;
        try {
          cachedPlan = await this.cachePlan(query, plan, planCost);
        } catch (error) {
          logger.warn(
            { query: query.name, error },
            "[dashboard-query-perf] failed to cache plan",
          );
        }

        results.push({
          name: query.name,
          route: query.route,
          description: query.description,
          planCost,
          analyzeDurationMs: Date.now() - startedAt,
          indexesUsed,
          seqScannedTables,
          overBudget:
            planCost != null && planCost > this.config.planCostBudget,
          cachedPlan,
        });
      } catch (error) {
        logger.warn(
          { query: query.name, error },
          "[dashboard-query-perf] EXPLAIN failed",
        );
        results.push({
          name: query.name,
          route: query.route,
          description: query.description,
          planCost: null,
          analyzeDurationMs: Date.now() - startedAt,
          indexesUsed: [],
          seqScannedTables: [],
          overBudget: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  /**
   * Derives index recommendations from the current plans: every sequential
   * scan above the cost floor that filters on a column yields a
   * `CREATE INDEX CONCURRENTLY` statement.
   *
   * Duplicates are collapsed by (table, columns) so a query touching the same
   * unindexed column several times produces one recommendation, not several.
   */
  async recommendMissingIndexes(
    queries: readonly DashboardQuery[] = DASHBOARD_QUERIES,
  ): Promise<IndexRecommendation[]> {
    const analyses = await this.explainDashboardQueries(queries);
    const byQuery = new Map(queries.map((q) => [q.name, q] as const));

    const seen = new Set<string>();
    const recommendations: IndexRecommendation[] = [];

    for (const analysis of analyses) {
      if (analysis.error || analysis.seqScannedTables.length === 0) continue;

      const query = byQuery.get(analysis.name);
      if (!query) continue;

      let plan: Record<string, unknown>;
      try {
        plan = await this.explain(query);
      } catch {
        // Already logged inside explain(); nothing further to add here.
        continue;
      }

      for (const scan of this.findSeqScans(plan)) {
        if ((scan.cost ?? 0) < this.config.minSeqScanCost) continue;

        const columns = extractFilterColumns(scan.filter);
        if (columns.length === 0) continue;

        const table = scan.relation;
        const key = `${table}:${columns.join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);

        recommendations.push({
          table,
          columns,
          createStatement:
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${table}_${columns.join("_")} ` +
            `ON ${table} (${columns.join(", ")});`,
          reason:
            `Query "${query.name}" (${query.route}) scans ${table} sequentially ` +
            `(cost ${scan.cost ?? 0}) filtering on ${columns.join(", ")}.`,
          sourceQuery: query.name,
          estimatedCost: scan.cost ?? null,
        });
      }
    }

    return recommendations;
  }

  /**
   * Samples table and index statistics for the dashboard's hot tables so an
   * operator can see seq-scan ratios and unused indexes over time.
   */
  async collectQueryPerformanceMetrics(
    tables: string[] = [...DEFAULT_MONITORED_TABLES],
  ): Promise<QueryPerformanceMetric[]> {
    try {
      const { rows } = await queryRead<Record<string, string | number | null>>(
        `SELECT s.relname                     AS table_name,
                s.seq_scan                    AS seq_scan,
                s.seq_tup_read                AS seq_tup_read,
                s.idx_scan                    AS idx_scan,
                s.n_live_tup                  AS live_tuples,
                s.n_dead_tup                  AS dead_tuples,
                s.last_seq_scan               AS last_seq_scan,
                COALESCE(u.unused_indexes, 0) AS unused_indexes
           FROM pg_stat_user_tables s
           LEFT JOIN (
             SELECT relid, COUNT(*)::int AS unused_indexes
               FROM pg_stat_user_indexes
              WHERE idx_scan = 0
              GROUP BY relid
           ) u ON u.relid = s.relid
          WHERE s.relname = ANY($1::text[])
          ORDER BY s.seq_tup_read DESC`,
        [tables],
      );

      return rows.map((row) => {
        const seqScan = Number(row.seq_scan ?? 0);
        const idxScan = Number(row.idx_scan ?? 0);
        const total = seqScan + idxScan;
        return {
          table: String(row.table_name),
          seqScans: seqScan,
          seqTuplesRead: Number(row.seq_tup_read ?? 0),
          indexScans: idxScan,
          liveTuples: Number(row.live_tuples ?? 0),
          deadTuples: Number(row.dead_tuples ?? 0),
          lastSeqScan: row.last_seq_scan
            ? new Date(row.last_seq_scan)
            : null,
          unusedIndexes: Number(row.unused_indexes ?? 0),
          // Share of accesses that went through a sequential scan. A rising
          // ratio is the signal that an access pattern outgrew its indexes.
          seqScanRatio: total > 0 ? seqScan / total : 0,
        };
      });
    } catch (error) {
      logger.warn(
        { error },
        "[dashboard-query-perf] failed to collect performance metrics",
      );
      return [];
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /** Runs EXPLAIN and unwraps the plan node from the JSON envelope. */
  private async explain(
    query: DashboardQuery,
  ): Promise<Record<string, unknown>> {
    const { rows } = await queryRead<Record<string, any>>(
      `EXPLAIN (FORMAT JSON, COSTS TRUE, VERBOSE FALSE) ${query.sql}`,
      query.params ?? [],
    );

    const payload = rows[0]?.["QUERY PLAN"];
    const plan = Array.isArray(payload) ? payload[0]?.Plan : payload?.Plan;
    if (!plan) {
      throw new Error(`EXPLAIN returned no plan for ${query.name}`);
    }
    return plan as Record<string, unknown>;
  }

  private async cachePlan(
    query: DashboardQuery,
    plan: Record<string, unknown>,
    planCost: number | null,
  ): Promise<CachedQueryPlan> {
    const optimizer = new DatabaseOptimizationService();
    return optimizer.cacheQueryPlan(query.sql, plan, planCost);
  }

  /** Every index name referenced anywhere in the plan tree. */
  private collectIndexesUsed(plan: Record<string, unknown>): string[] {
    const used = new Set<string>();
    const walk = (node: PlanNode) => {
      if (node["Index Name"]) used.add(node["Index Name"]);
      node.Plans?.forEach(walk);
    };
    walk(plan as PlanNode);
    return [...used];
  }

  /** Distinct relations reached by a sequential scan. */
  private collectSeqScannedTables(plan: Record<string, unknown>): string[] {
    const tables = new Set<string>();
    this.findSeqScans(plan).forEach((scan) => tables.add(scan.relation));
    return [...tables];
  }

  /** Flattened list of sequential-scan nodes with their filters and cost. */
  private findSeqScans(plan: Record<string, unknown>): SeqScanInfo[] {
    const found: SeqScanInfo[] = [];
    const walk = (node: PlanNode) => {
      if (node["Node Type"] === "Seq Scan" && node["Relation Name"]) {
        found.push({
          relation: node["Relation Name"],
          filter: node.Filter,
          cost: node["Total Cost"] ?? node["Plan Cost"],
        });
      }
      node.Plans?.forEach(walk);
    };
    walk(plan as PlanNode);
    return found;
  }
}

/**
 * Reads the top-level cost out of an `EXPLAIN (FORMAT JSON)` plan node.
 *
 * PostgreSQL emits the node's cost as `Total Cost`; the query-plan cache
 * (#482) stores it under `Plan Cost`, so both spellings are accepted.
 * Returns null rather than guessing when neither is present.
 */
export function readPlanCost(plan: Record<string, unknown>): number | null {
  for (const key of ["Total Cost", "Plan Cost", "total_cost"]) {
    const value = Number(plan?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Extracts filterable column names from a plan `Filter` expression.
 *
 * Handles the two forms the planner emits for the dashboard queries —
 * `((reference_number)::text = 'PR-1'::text)` and
 * `((status)::text = ANY ('{completed}'::text[]))` — and ignores anything it
 * cannot confidently attribute to a column, because a wrong column in a
 * `CREATE INDEX` is worse than no recommendation at all.
 */
export function extractFilterColumns(filter?: string): string[] {
  if (!filter) return [];

  const columns = new Set<string>();
  // "((column)::text = " and "(column = ANY ("
  const cast = /\(\s*([a-z_][a-z0-9_]*)\s*\)?\s*::/gi;
  const anyForm = /\(\s*([a-z_][a-z0-9_]*)\s*\)?\s*=\s*ANY/gi;
  const bare = /\(\s*([a-z_][a-z0-9_]*)\s*\)?\s*=/gi;

  for (const pattern of [cast, anyForm, bare]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(filter)) !== null) {
      columns.add(match[1]);
    }
  }

  return [...columns];
}

export const adminDashboardQueryPerformanceService =
  new AdminDashboardQueryPerformanceService();
