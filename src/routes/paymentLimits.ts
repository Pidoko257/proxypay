import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  paymentLimitsService,
  CreatePaymentLimitRequest,
  KYCTier,
} from "../services/paymentLimitsService";
import { authenticateToken } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

const kycTierEnum = z.enum(["unverified", "basic", "full"]);

const createLimitSchema = z
  .object({
    organizationId: z.string().min(1),
    kycTier: kycTierEnum,
    dailyLimit: z.number().min(0),
    weeklyLimit: z.number().min(0),
    monthlyLimit: z.number().min(0),
  })
  .refine(
    (data) =>
      data.weeklyLimit >= data.dailyLimit &&
      data.monthlyLimit >= data.weeklyLimit,
    {
      message:
        "Limits must be ordered: dailyLimit <= weeklyLimit <= monthlyLimit",
      path: ["monthlyLimit"],
    },
  );

const updateLimitSchema = z.object({
  dailyLimit: z.number().min(0).optional(),
  weeklyLimit: z.number().min(0).optional(),
  monthlyLimit: z.number().min(0).optional(),
});

const checkLimitSchema = z.object({
  organizationId: z.string().min(1),
  kycTier: kycTierEnum,
  amount: z.number().positive(),
});

/**
 * POST /api/payment-limits/check
 * Check whether a transaction would exceed configured limits (no write).
 */
router.post(
  "/check",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { organizationId, kycTier, amount } = checkLimitSchema.parse(
        req.body,
      );
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User ID required");
      }

      const result = await paymentLimitsService.checkTransactionLimit(
        userId,
        organizationId,
        kycTier as KYCTier,
        amount,
      );

      if (!result.allowed) {
        throw createError(ERROR_CODES.LIMIT_EXCEEDED, result.message, {
          code: "ERR_LIMIT_EXCEEDED",
          kycTier: result.kycTier,
          period: result.period,
          limit: result.limit,
          currentUsage: result.currentUsage,
          remainingLimit: result.remainingLimit,
          dailyUsage: result.dailyUsage,
          weeklyUsage: result.weeklyUsage,
          monthlyUsage: result.monthlyUsage,
          dailyLimit: result.dailyLimit,
          weeklyLimit: result.weeklyLimit,
          monthlyLimit: result.monthlyLimit,
        });
      }

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      throw error;
    }
  },
);

/**
 * GET /api/payment-limits
 * List all limit configs for an organization.
 * Requires ?organizationId query param.
 */
router.get("/", authenticateToken, async (req: Request, res: Response) => {
  try {
    const organizationId = req.query.organizationId;
    if (typeof organizationId !== "string" || !organizationId) {
      throw createError(
        ERROR_CODES.MISSING_FIELD,
        "organizationId query parameter is required",
      );
    }

    const limits =
      await paymentLimitsService.getAllLimitsForOrg(organizationId);

    res.json({
      success: true,
      data: limits,
    });
  } catch (error: any) {
    if (error.code) throw error;
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to fetch payment limits",
    );
  }
});

/**
 * GET /api/payment-limits/:id
 * Get a single limit configuration by ID.
 */
router.get("/:id", authenticateToken, async (req: Request, res: Response) => {
  try {
    const limit = await paymentLimitsService.getLimitById(req.params.id);
    if (!limit) {
      throw createError(
        ERROR_CODES.NOT_FOUND,
        "Payment limit configuration not found",
      );
    }

    res.json({
      success: true,
      data: limit,
    });
  } catch (error: any) {
    if (error.code) throw error;
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to fetch payment limit",
    );
  }
});

/**
 * POST /api/payment-limits
 * Create or update a payment limit configuration (admin only).
 */
router.post(
  "/",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const data = createLimitSchema.parse(
        req.body,
      ) as CreatePaymentLimitRequest;

      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User ID required");
      }

      const limit = await paymentLimitsService.createOrUpdateLimit(
        data,
        userId,
        req.ip,
        req.get("User-Agent"),
      );

      res.status(201).json({
        success: true,
        data: limit,
      });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      throw error;
    }
  },
);

/**
 * PATCH /api/payment-limits/:id
 * Partially update a payment limit configuration (admin only).
 */
router.patch(
  "/:id",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const data = updateLimitSchema.parse(req.body);
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User ID required");
      }

      const limit = await paymentLimitsService.updateLimit(
        req.params.id,
        data,
        userId,
        req.ip,
        req.get("User-Agent"),
      );

      if (!limit) {
        throw createError(
          ERROR_CODES.NOT_FOUND,
          "Payment limit configuration not found",
        );
      }

      res.json({
        success: true,
        data: limit,
      });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          details: error.errors,
        });
      }
      if (error.code) throw error;
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to update payment limit",
      );
    }
  },
);

/**
 * DELETE /api/payment-limits/:id
 * Delete a payment limit configuration (admin only).
 */
router.delete(
  "/:id",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const userId = req.jwtUser?.userId;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "User ID required");
      }

      const deleted = await paymentLimitsService.deleteLimit(
        req.params.id,
        userId,
        req.ip,
        req.get("User-Agent"),
      );

      if (!deleted) {
        throw createError(
          ERROR_CODES.NOT_FOUND,
          "Payment limit configuration not found",
        );
      }

      res.json({
        success: true,
        message: "Payment limit configuration deleted successfully",
      });
    } catch (error: any) {
      if (error.code) throw error;
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to delete payment limit",
      );
    }
  },
);

/**
 * GET /api/payment-limits/:id/audit
 * Get audit history for a payment limit configuration (admin only).
 */
router.get(
  "/:id/audit",
  authenticateToken,
  requirePermission("admin:system"),
  async (req: Request, res: Response) => {
    try {
      const auditHistory = await paymentLimitsService.getAuditHistory(
        req.params.id,
      );

      res.json({
        success: true,
        data: auditHistory,
      });
    } catch (error: any) {
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch audit history",
      );
    }
  },
);

export default router;
