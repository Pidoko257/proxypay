/**
 * Alert Aggregation Admin API — issue #263
 *
 * Routes:
 *   GET  /api/admin/alerts/groups          — list active (pending) alert groups
 *   GET  /api/admin/alerts/rules           — list current grouping rules
 *   PUT  /api/admin/alerts/rules           — replace all rules (full update)
 *   POST /api/admin/alerts/rules           — add/update a single rule (upsert)
 *   POST /api/admin/alerts/flush           — flush all groups immediately
 *   POST /api/admin/alerts/ingest          — inject a test alert (dev/staging only)
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { alertAggregator, GroupingRule } from "../services/alertAggregationService";

const router = Router();

/**
 * GET /api/admin/alerts/groups
 * Returns all currently open alert groups that have not yet fired.
 */
router.get("/groups", requireAuth, (_req: Request, res: Response) => {
  const groups = alertAggregator.getActiveGroups();
  res.json({
    count: groups.length,
    groups,
    generated_at: new Date().toISOString(),
  });
});

/**
 * GET /api/admin/alerts/rules
 * Returns the currently active grouping rules.
 */
router.get("/rules", requireAuth, (_req: Request, res: Response) => {
  res.json({
    rules: alertAggregator.getRules(),
    generated_at: new Date().toISOString(),
  });
});

/**
 * PUT /api/admin/alerts/rules
 * Replace the full set of grouping rules.
 * Body: { rules: GroupingRule[] }
 */
router.put("/rules", requireAuth, (req: Request, res: Response) => {
  const { rules } = req.body as { rules: GroupingRule[] };

  if (!Array.isArray(rules)) {
    res.status(400).json({ error: "rules must be an array" });
    return;
  }

  for (const rule of rules) {
    if (
      typeof rule.service !== "string" ||
      typeof rule.alertType !== "string" ||
      typeof rule.threshold !== "number" ||
      typeof rule.windowMs !== "number"
    ) {
      res.status(400).json({
        error: "Each rule must have service (string), alertType (string), threshold (number), windowMs (number)",
      });
      return;
    }
  }

  alertAggregator.setRules(rules);
  res.json({ ok: true, rules: alertAggregator.getRules() });
});

/**
 * POST /api/admin/alerts/rules
 * Add or update a single grouping rule.
 * Body: GroupingRule
 */
router.post("/rules", requireAuth, (req: Request, res: Response) => {
  const rule = req.body as GroupingRule;

  if (
    typeof rule.service !== "string" ||
    typeof rule.alertType !== "string" ||
    typeof rule.threshold !== "number" ||
    typeof rule.windowMs !== "number"
  ) {
    res.status(400).json({
      error: "Rule must have service (string), alertType (string), threshold (number), windowMs (number)",
    });
    return;
  }

  alertAggregator.upsertRule(rule);
  res.status(201).json({ ok: true, rule, rules: alertAggregator.getRules() });
});

/**
 * POST /api/admin/alerts/flush
 * Flush all pending alert groups immediately (forces delivery of any
 * batched alerts — useful before planned maintenance).
 */
router.post("/flush", requireAuth, async (_req: Request, res: Response) => {
  await alertAggregator.flushAll();
  res.json({ ok: true, message: "All pending alert groups flushed" });
});

/**
 * POST /api/admin/alerts/ingest
 * Inject a test alert (only available in non-production environments).
 * Body: AlertPayload
 */
router.post("/ingest", requireAuth, (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    res.status(403).json({ error: "Test alert injection is disabled in production" });
    return;
  }

  const { service, alertType, severity, message, metadata, groupBy } = req.body as {
    service: string;
    alertType: string;
    severity: string;
    message: string;
    metadata?: Record<string, unknown>;
    groupBy?: string;
  };

  if (!service || !alertType || !severity || !message) {
    res.status(400).json({ error: "service, alertType, severity, message are required" });
    return;
  }

  alertAggregator.ingest({
    service,
    alertType,
    severity: severity as "critical" | "error" | "warning" | "info",
    message,
    metadata,
    groupBy,
  });

  res.json({ ok: true, message: "Alert ingested" });
});

export { router as alertAggregationRoutes };
