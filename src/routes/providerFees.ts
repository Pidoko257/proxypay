/**
 * Provider Fee Configuration API — Issue #200
 *
 * Endpoints:
 *   GET    /api/fees/providers                              — All provider fee configs
 *   GET    /api/fees/providers/:provider                    — Provider fee history
 *   POST   /api/fees/providers/:provider                    — Create provider fee config
 *   POST   /api/fees/providers/:provider/:id/activate       — Activate specific version
 *   POST   /api/fees/simulate                               — Simulate fee change impact
 *   GET    /api/fees/analytics                              — Fee analytics
 *   GET    /api/fees/proposals                              — List fee change proposals
 *   POST   /api/fees/proposals                              — Submit fee change proposal
 *   POST   /api/fees/proposals/:id/review                   — Approve/reject proposal
 *   POST   /api/fees/display                                — Fee display helper
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  providerFeeService,
  ProviderName,
  ApprovalStatus,
} from "../services/providerFeeService";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

const VALID_PROVIDERS: ProviderName[] = ["mtn", "airtel", "orange"];

function validateProvider(name: string): ProviderName {
  if (!VALID_PROVIDERS.includes(name as ProviderName)) {
    throw createError(
      ERROR_CODES.INVALID_INPUT,
      `Invalid provider: ${name}. Must be one of: ${VALID_PROVIDERS.join(", ")}`,
    );
  }
  return name as ProviderName;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const createProviderFeeSchema = z
  .object({
    feePercentage: z.number().min(0).max(100),
    feeMinimum: z.number().min(0),
    feeMaximum: z.number().min(0),
    description: z.string().optional(),
  })
  .refine((d) => d.feeMaximum >= d.feeMinimum, {
    message: "feeMaximum must be >= feeMinimum",
    path: ["feeMaximum"],
  });

const simulateFeeSchema = z
  .object({
    provider: z.enum(["mtn", "airtel", "orange"] as const).nullable(),
    feePercentage: z.number().min(0).max(100),
    feeMinimum: z.number().min(0),
    feeMaximum: z.number().min(0),
    sampleAmounts: z.array(z.number().positive()).max(20).optional(),
  })
  .refine((d) => d.feeMaximum >= d.feeMinimum, {
    message: "feeMaximum must be >= feeMinimum",
    path: ["feeMaximum"],
  });

const analyticsSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provider: z.enum(["mtn", "airtel", "orange"] as const).optional(),
});

const proposeFeeChangeSchema = z.object({
  provider: z.enum(["mtn", "airtel", "orange"] as const).nullable(),
  feeConfigId: z.string().uuid().nullable(),
  proposedChanges: z.record(z.unknown()),
});

const reviewProposalSchema = z.object({
  decision: z.enum(["approved", "rejected"] as const),
  reviewNote: z.string().optional(),
});

const feeDisplaySchema = z.object({
  amount: z.number().positive(),
  provider: z.enum(["mtn", "airtel", "orange"] as const).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/fees/providers
 * List all provider fee configurations across all providers.
 */
router.get(
  "/providers",
  authenticateToken,
  requirePermission("admin:system"),
  async (_req: Request, res: Response) => {
    try {
      const configs = await providerFeeService.getAllProviderFeeConfigs();
      res.json({ success: true, data: configs });
    } catch (error) {
      console.error("[ProviderFees] list all error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch provider fee configurations");
    }
  },
);

/**
 * GET /api/fees/providers/:provider
 * List fee configuration history for a specific provider.
 */
router.get(
  "/providers/:provider",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const provider = validateProvider(req.params.provider);
      const configs = await providerFeeService.getAllProviderFeeConfigs(provider);
      res.json({ success: true, data: configs });
    } catch (error) {
      console.error("[ProviderFees] list provider error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch provider fee configurations",
      );
    }
  },
);

/**
 * POST /api/fees/providers/:provider
 * Create a new (inactive) fee configuration version for a provider.
 *
 * Body: { feePercentage, feeMinimum, feeMaximum, description? }
 */
router.post(
  "/providers/:provider",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const provider = validateProvider(req.params.provider);
      const data = createProviderFeeSchema.parse(req.body);

      const config = await providerFeeService.createProviderFeeConfig(
        { ...data, provider },
        req.jwtUser!.userId,
      );

      res.status(201).json({ success: true, data: config });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[ProviderFees] create error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to create provider fee configuration",
      );
    }
  },
);

/**
 * POST /api/fees/providers/:provider/:id/activate
 * Activate a specific version of a provider fee configuration.
 */
router.post(
  "/providers/:provider/:id/activate",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      validateProvider(req.params.provider); // validate provider name
      const config = await providerFeeService.activateProviderFeeConfig(
        req.params.id,
        req.jwtUser!.userId,
      );

      if (!config) {
        throw createError(ERROR_CODES.NOT_FOUND, "Provider fee configuration not found");
      }

      res.json({
        success: true,
        data: config,
        message: `Fee configuration v${config.version} activated for ${config.provider}`,
      });
    } catch (error) {
      console.error("[ProviderFees] activate error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to activate provider fee configuration",
      );
    }
  },
);

/**
 * POST /api/fees/simulate
 * Simulate the fee impact of proposed parameters.
 *
 * Body:
 * {
 *   "provider": "mtn" | null,
 *   "feePercentage": 2.0,
 *   "feeMinimum": 75,
 *   "feeMaximum": 6000,
 *   "sampleAmounts": [1000, 10000, 100000]  // optional
 * }
 */
router.post(
  "/simulate",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const proposal = simulateFeeSchema.parse(req.body);
      const result = await providerFeeService.simulateFee(proposal, proposal.sampleAmounts);
      res.json({ success: true, data: result });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[ProviderFees] simulate error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to simulate fee");
    }
  },
);

/**
 * GET /api/fees/analytics
 * Get fee analytics for a period.
 *
 * Query params: startDate, endDate, provider (optional)
 */
router.get(
  "/analytics",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const params = analyticsSchema.parse({
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        provider: req.query.provider,
      });

      const analytics = await providerFeeService.getFeeAnalytics(
        params.startDate,
        params.endDate,
        params.provider,
      );

      res.json({ success: true, data: analytics });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[ProviderFees] analytics error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch fee analytics");
    }
  },
);

/**
 * GET /api/fees/proposals
 * List fee change proposals. Filter by status with ?status=pending
 */
router.get(
  "/proposals",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const validStatuses: ApprovalStatus[] = ["pending", "approved", "rejected", "superseded"];
      const statusParam = req.query.status as string | undefined;
      const status =
        statusParam && validStatuses.includes(statusParam as ApprovalStatus)
          ? (statusParam as ApprovalStatus)
          : undefined;

      const proposals = await providerFeeService.getFeeChangeProposals(status);
      res.json({ success: true, data: proposals });
    } catch (error) {
      console.error("[ProviderFees] list proposals error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to fetch fee change proposals");
    }
  },
);

/**
 * POST /api/fees/proposals
 * Submit a fee change proposal for review.
 */
router.post(
  "/proposals",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const data = proposeFeeChangeSchema.parse(req.body);
      const proposal = await providerFeeService.proposeFeeChange(data, req.jwtUser!.userId);
      res.status(201).json({ success: true, data: proposal });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[ProviderFees] propose error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to submit fee change proposal");
    }
  },
);

/**
 * POST /api/fees/proposals/:id/review
 * Approve or reject a fee change proposal.
 */
router.post(
  "/proposals/:id/review",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const { decision, reviewNote } = reviewProposalSchema.parse(req.body);
      const proposal = await providerFeeService.reviewFeeChangeProposal(
        req.params.id,
        decision,
        req.jwtUser!.userId,
        reviewNote,
      );

      if (!proposal) {
        throw createError(
          ERROR_CODES.NOT_FOUND,
          "Proposal not found or is no longer pending",
        );
      }

      res.json({ success: true, data: proposal });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      console.error("[ProviderFees] review error:", error);
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to review fee change proposal");
    }
  },
);

/**
 * POST /api/fees/display
 * Get a formatted fee display for a given amount and optional provider.
 * Intended for use in transaction preview and checkout flows.
 *
 * Body: { amount: number, provider?: "mtn" | "airtel" | "orange" }
 */
router.post("/display", async (req: Request, res: Response) => {
  try {
    const { amount, provider } = feeDisplaySchema.parse(req.body);
    const display = await providerFeeService.buildFeeDisplay(amount, provider);
    res.json({ success: true, data: display });
  } catch (error: any) {
    if (error.name === "ZodError") {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
        details: error.errors,
      });
    }
    console.error("[ProviderFees] display error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to build fee display");
  }
});

export default router;
