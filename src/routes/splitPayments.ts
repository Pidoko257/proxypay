/**
 * Split Payments Routes
 *
 * Rules router  (mount at /api/split-payments):
 *   GET    /rules           → list rules
 *   POST   /rules           → create rule
 *   GET    /rules/:id       → get rule details
 *   PUT    /rules/:id       → update rule
 *   DELETE /rules/:id       → deactivate rule (soft delete)
 *
 * Transaction router  (mount at /api/transactions):
 *   POST   /:id/split       → apply split rule to a transaction
 *   GET    /:id/splits      → get split breakdown for a transaction
 */

import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth";
import { SplitPaymentService } from "../services/splitPaymentService";
import { SplitPaymentModel } from "../models/splitPayment";

// Shared service instance
const splitPaymentService = new SplitPaymentService(new SplitPaymentModel());

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Wraps an async route handler to forward unhandled errors to Express. */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Split-Payment Rule router  (/api/split-payments)
// ---------------------------------------------------------------------------

export const splitPaymentRulesRouter = Router();

/**
 * GET /api/split-payments/rules
 * List all split payment rules.
 * Query params: isActive (true|false), limit, offset
 */
splitPaymentRulesRouter.get(
  "/rules",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { isActive, limit, offset } = req.query;

    const options: { isActive?: boolean; limit?: number; offset?: number } = {};

    if (isActive !== undefined) {
      options.isActive = isActive === "true";
    }
    if (limit !== undefined) {
      const l = parseInt(String(limit), 10);
      if (!isNaN(l) && l > 0) options.limit = l;
    }
    if (offset !== undefined) {
      const o = parseInt(String(offset), 10);
      if (!isNaN(o) && o >= 0) options.offset = o;
    }

    const model = new SplitPaymentModel();
    const rules = await model.listRules(options);
    res.json({ data: rules, count: rules.length });
  }),
);

/**
 * POST /api/split-payments/rules
 * Create a new split payment rule.
 * Body: { name, description?, recipients[] }
 */
splitPaymentRulesRouter.post(
  "/rules",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { name, description, recipients } = req.body as {
      name: string;
      description?: string;
      recipients: Array<{
        recipientType: "user" | "merchant" | "phone";
        recipientId: string;
        recipientLabel?: string;
        splitType: "percentage" | "fixed";
        splitValue: number;
        priority?: number;
      }>;
    };

    if (!name) {
      res.status(400).json({ error: "name is required." });
      return;
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      res.status(400).json({ error: "recipients must be a non-empty array." });
      return;
    }

    const validation = splitPaymentService.validateRecipients(recipients);
    if (!validation.valid) {
      res.status(400).json({ error: "Invalid recipients.", details: validation.errors });
      return;
    }

    const createdBy = (req as Request & { user?: { id?: string } }).user?.id ?? null;

    const rule = await splitPaymentService.createRule(
      name,
      description ?? null,
      recipients,
      createdBy,
    );

    res.status(201).json({ data: rule });
  }),
);

/**
 * GET /api/split-payments/rules/:id
 * Get a specific rule by ID, including its recipients.
 */
splitPaymentRulesRouter.get(
  "/rules/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const model = new SplitPaymentModel();
    const rule = await model.findRuleById(id);

    if (!rule) {
      res.status(404).json({ error: "Split payment rule not found." });
      return;
    }

    res.json({ data: rule });
  }),
);

/**
 * PUT /api/split-payments/rules/:id
 * Update a rule's name, description, or active status.
 * Body: { name?, description?, isActive? }
 */
splitPaymentRulesRouter.put(
  "/rules/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, description, isActive } = req.body as {
      name?: string;
      description?: string;
      isActive?: boolean;
    };

    const updates: { name?: string; description?: string; isActive?: boolean } = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (isActive !== undefined) updates.isActive = isActive;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update provided." });
      return;
    }

    const model = new SplitPaymentModel();
    const updated = await model.updateRule(id, updates);

    if (!updated) {
      res.status(404).json({ error: "Split payment rule not found." });
      return;
    }

    res.json({ data: updated });
  }),
);

/**
 * DELETE /api/split-payments/rules/:id
 * Deactivate (soft-delete) a rule.
 */
splitPaymentRulesRouter.delete(
  "/rules/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const model = new SplitPaymentModel();
    const deactivated = await model.deleteRule(id);

    if (!deactivated) {
      res.status(404).json({ error: "Split payment rule not found." });
      return;
    }

    res.json({ data: deactivated, message: "Rule deactivated successfully." });
  }),
);

// ---------------------------------------------------------------------------
// Transaction split router  (/api/transactions)
// ---------------------------------------------------------------------------

export const splitPaymentTransactionRouter = Router();

/**
 * POST /api/transactions/:id/split
 * Apply a split rule to an existing transaction.
 * Body: { ruleId, totalAmount, currency? }
 */
splitPaymentTransactionRouter.post(
  "/:id/split",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const transactionId = req.params.id;
    const { ruleId, totalAmount, currency } = req.body as {
      ruleId: string;
      totalAmount: number;
      currency?: string;
    };

    if (!ruleId) {
      res.status(400).json({ error: "ruleId is required." });
      return;
    }
    if (totalAmount === undefined || totalAmount === null) {
      res.status(400).json({ error: "totalAmount is required." });
      return;
    }
    if (typeof totalAmount !== "number" || isNaN(totalAmount) || totalAmount <= 0) {
      res.status(400).json({ error: "totalAmount must be a positive number." });
      return;
    }

    const entries = await splitPaymentService.processTransaction(
      transactionId,
      ruleId,
      totalAmount,
      currency ?? "XAF",
    );

    res.status(201).json({ data: entries, count: entries.length });
  }),
);

/**
 * GET /api/transactions/:id/splits
 * Get the split breakdown for a specific transaction.
 */
splitPaymentTransactionRouter.get(
  "/:id/splits",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const transactionId = req.params.id;
    const summary = await splitPaymentService.getSplitSummary(transactionId);
    res.json({ data: summary });
  }),
);
