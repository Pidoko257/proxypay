/**
 * Cost Allocation Metrics API — issue #261
 *
 * Exposes unit economics data (cost per transaction by provider and feature)
 * as a JSON endpoint consumed by analytics dashboards and data pipelines.
 *
 * Routes:
 *   GET /api/admin/cost-allocation        — unit cost analytics (JSON)
 *   GET /api/admin/cost-allocation/export — CSV export for data warehouse
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { costMetrics } from "../services/costAllocationMetrics";

const router = Router();

/**
 * GET /api/admin/cost-allocation
 * Returns cost-per-transaction analytics grouped by provider and feature.
 * Identifies the most expensive features and enables capacity planning.
 */
router.get("/", requireAuth, (_req: Request, res: Response) => {
  const records = costMetrics.getUnitCostAnalytics();

  // Aggregate totals for the summary block
  const summary = records.reduce(
    (acc, r) => ({
      total_api_calls: acc.total_api_calls + r.api_calls,
      total_db_queries: acc.total_db_queries + r.db_queries,
      total_storage_bytes: acc.total_storage_bytes + r.storage_bytes,
      total_transactions: acc.total_transactions + r.total_transactions,
    }),
    {
      total_api_calls: 0,
      total_db_queries: 0,
      total_storage_bytes: 0,
      total_transactions: 0,
    },
  );

  res.json({
    generated_at: new Date().toISOString(),
    summary,
    records,
    note: "Costs are estimated from configurable per-unit rates. Override via COST_PER_API_CALL_USD_CENTS, COST_PER_DB_QUERY_USD_CENTS, COST_PER_STORAGE_KB_USD_CENTS env vars.",
  });
});

/**
 * GET /api/admin/cost-allocation/export
 * Returns cost analytics as a CSV for import into BigQuery / Redshift / Excel.
 */
router.get("/export", requireAuth, (_req: Request, res: Response) => {
  const records = costMetrics.getUnitCostAnalytics();

  const header =
    "provider,feature,api_calls,db_queries,storage_bytes,total_transactions," +
    "estimated_api_cost_usd_cents_per_tx,estimated_db_cost_usd_cents_per_tx," +
    "estimated_total_cost_usd_cents_per_tx\n";

  const rows = records
    .map(
      (r) =>
        `${r.provider},${r.feature},${r.api_calls},${r.db_queries},` +
        `${r.storage_bytes},${r.total_transactions},` +
        `${r.estimated_api_cost_usd_cents_per_tx},` +
        `${r.estimated_db_cost_usd_cents_per_tx},` +
        `${r.estimated_total_cost_usd_cents_per_tx}`,
    )
    .join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="cost-allocation-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.send(header + rows);
});

export { router as costAllocationRoutes };
