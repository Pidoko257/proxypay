/**
 * Transaction Funnel Dashboard API — issue #262
 *
 * Routes:
 *   GET /api/funnel/snapshot    — current funnel breakdown by provider + type
 *   GET /api/funnel/timeseries  — time-series funnel for sparklines/charts
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { transactionFunnelService } from "../services/transactionFunnelService";

const router = Router();

/**
 * GET /api/funnel/snapshot?granularity=daily&lookback=24
 * Returns the funnel conversion snapshot grouped by provider and transaction type.
 * Shows initiated → verified → processing → completed with drop-off analysis.
 */
router.get("/snapshot", requireAuth, async (req: Request, res: Response) => {
  const granularity =
    req.query["granularity"] === "hourly" ? "hourly" : "daily";
  const lookback = Math.min(
    parseInt((req.query["lookback"] as string) || "24", 10),
    720, // cap at 30 days
  );

  const snapshots = await transactionFunnelService.getFunnelSnapshot(
    granularity,
    lookback,
  );

  res.json({
    generated_at: new Date().toISOString(),
    granularity,
    lookback_hours: lookback,
    total_providers: new Set(snapshots.map((s) => s.provider)).size,
    snapshots,
  });
});

/**
 * GET /api/funnel/timeseries?granularity=hourly&lookback=48
 * Returns time-bucketed funnel data for trend charts and sparklines.
 * Integrates with Grafana via the Prometheus data source (see dashboard JSON).
 */
router.get("/timeseries", requireAuth, async (req: Request, res: Response) => {
  const granularity =
    req.query["granularity"] === "hourly" ? "hourly" : "daily";
  const lookback = Math.min(
    parseInt((req.query["lookback"] as string) || "48", 10),
    720,
  );

  const timeSeries = await transactionFunnelService.getFunnelTimeSeries(
    granularity,
    lookback,
  );

  res.json(timeSeries);
});

export { router as funnelRoutes };
