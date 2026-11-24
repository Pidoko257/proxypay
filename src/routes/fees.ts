import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  feeService,
  CreateFeeConfigRequest,
  UpdateFeeConfigRequest,
} from "../services/feeService";
import { feeAuditService } from "../services/feeAuditService";
import { layeredCache } from "../services/layeredCache";
import { requirePermission } from "../middleware/rbac";
import { authenticateToken } from "../middleware/auth";
import { calculateFeeForUser } from "../utils/fees";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

// Validation schemas
const createFeeConfigSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    feePercentage: z.number().min(0).max(100),
    feeMinimum: z.number().min(0),
    feeMaximum: z.number().min(0),
  })
  .refine((data) => data.feeMaximum >= data.feeMinimum, {
    message: "Fee maximum must be greater than or equal to fee minimum",
    path: ["feeMaximum"],
  });

const updateFeeConfigSchema = z
  .object({
    description: z.string().optional(),
    feePercentage: z.number().min(0).max(100).optional(),
    feeMinimum: z.number().min(0).optional(),
    feeMaximum: z.number().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (data) => {
      if (data.feeMaximum !== undefined && data.feeMinimum !== undefined) {
        return data.feeMaximum >= data.feeMinimum;
      }
      return true;
    },
    {
      message: "Fee maximum must be greater than or equal to fee minimum",
      path: ["feeMaximum"],
    },
  );

const calculateFeeSchema = z.object({
  amount: z.number().positive(),
});

const estimateFeeSchema = z.object({
  amount: z.number().positive("Transaction amount must be a positive number"),
  userId: z.string().uuid().optional(),
  senderPhone: z.string().optional(),
  recipientPhone: z.string().optional(),
  transactionType: z
    .enum(["send", "deposit", "withdraw", "payment"])
    .optional(),
});

/**
 * Middleware: Log admin fee actions
 */
const logFeeAction = (action: string) => {
  return (req: Request, res: Response, next: any) => {
    console.log(`[FEE ACTION] ${action}`, {
      adminId: req.jwtUser?.userId,
      method: req.method,
      path: req.originalUrl,
      body: req.body,
      timestamp: new Date().toISOString(),
    });
    next();
  };
};

/**
 * POST /api/fees/estimate
 * Pre-flight endpoint: calculate exact fees / net amount before committing.
 * Accepts a mock transaction payload and returns a detailed breakdown.
 */
router.post("/estimate", async (req: Request, res: Response) => {
  try {
    const payload = estimateFeeSchema.parse(req.body);
    const { amount, userId, senderPhone, recipientPhone, transactionType } =
      payload;

    let responseData: Record<string, unknown>;

    if (userId) {
      // VIP-tier-aware calculation
      const vipResult = await calculateFeeForUser(amount, userId);

      // Derive effective rate from the fee and amount
      const effectiveRate =
        amount > 0
          ? parseFloat(((vipResult.fee / amount) * 100).toFixed(4))
          : 0;

      // Fetch base config for breakdown details
      let baseFeeRate = 1.5;
      let feeMinimum = 50;
      let feeMaximum = 5000;
      try {
        const activeCfg = await feeService.getActiveConfiguration();
        baseFeeRate = activeCfg.feePercentage;
        feeMinimum = activeCfg.feeMinimum;
        feeMaximum = activeCfg.feeMaximum;
      } catch {
        // Use env fallback defaults already assigned
      }

      const multiplier = 1 - vipResult.discountPercent / 100;
      const discountedMin = parseFloat((feeMinimum * multiplier).toFixed(2));
      const discountedMax = parseFloat((feeMaximum * multiplier).toFixed(2));
      const feeBeforeClamping = parseFloat(
        (amount * ((baseFeeRate * multiplier) / 100)).toFixed(2),
      );
      const wasClamped = vipResult.fee !== feeBeforeClamping;

      responseData = {
        transactionAmount: amount,
        fee: vipResult.fee,
        netAmount: parseFloat((amount - vipResult.fee).toFixed(2)),
        totalCharged: vipResult.total,
        feePercentageApplied: effectiveRate,
        configUsed: vipResult.configUsed,
        tier: vipResult.tier,
        discountPercent: vipResult.discountPercent,
        thirtyDayVolume: vipResult.thirtyDayVolume,
        breakdown: {
          baseFeeRate: `${baseFeeRate}%`,
          vipDiscount: `${vipResult.discountPercent}%`,
          effectiveRate: `${effectiveRate}%`,
          feeBeforeClamping,
          feeMinimum: discountedMin,
          feeMaximum: discountedMax,
          wasClamped,
        },
        ...(senderPhone && { senderPhone }),
        ...(recipientPhone && { recipientPhone }),
        ...(transactionType && { transactionType }),
        estimatedAt: new Date().toISOString(),
        disclaimer:
          "This is an estimate. Final fees may vary based on configuration at time of transaction.",
      };
    } else {
      // Standard fee calculation (no VIP tier)
      const result = await feeService.calculateFee(amount);

      const effectiveRate =
        amount > 0 ? parseFloat(((result.fee / amount) * 100).toFixed(4)) : 0;

      // Fetch active config for breakdown
      let baseFeeRate = 1.5;
      let feeMinimum = 50;
      let feeMaximum = 5000;
      try {
        const activeCfg = await feeService.getActiveConfiguration();
        baseFeeRate = activeCfg.feePercentage;
        feeMinimum = activeCfg.feeMinimum;
        feeMaximum = activeCfg.feeMaximum;
      } catch {
        // Use env fallback defaults already assigned
      }

      const feeBeforeClamping = parseFloat(
        (amount * (baseFeeRate / 100)).toFixed(2),
      );
      const wasClamped = result.fee !== feeBeforeClamping;

      responseData = {
        transactionAmount: amount,
        fee: result.fee,
        netAmount: parseFloat((amount - result.fee).toFixed(2)),
        totalCharged: result.total,
        feePercentageApplied: effectiveRate,
        configUsed: result.configUsed,
        breakdown: {
          baseFeeRate: `${baseFeeRate}%`,
          vipDiscount: "0%",
          effectiveRate: `${effectiveRate}%`,
          feeBeforeClamping,
          feeMinimum,
          feeMaximum,
          wasClamped,
        },
        ...(senderPhone && { senderPhone }),
        ...(recipientPhone && { recipientPhone }),
        ...(transactionType && { transactionType }),
        estimatedAt: new Date().toISOString(),
        disclaimer:
          "This is an estimate. Final fees may vary based on configuration at time of transaction.",
      };
    }

    res.json({
      success: true,
      data: responseData,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
        success: false,
        error: "Validation error",
        details: error.errors,
      });
    }

    console.error("Fee estimation error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to estimate fee", {
      success: false,
      error: "Failed to estimate fee",
    });
  }
});

/**
 * POST /api/fees/calculate
 * Calculate fee for given amount using active configuration
 */
router.post("/calculate", async (req: Request, res: Response) => {
  try {
    const { amount } = calculateFeeSchema.parse(req.body);

    const result = await feeService.calculateFee(amount);

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
        success: false,
        error: "Validation error",
        details: error.errors,
      });
    }

    console.error("Fee calculation error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to calculate fee", {
      success: false,
      error: "Failed to calculate fee",
    });
  }
});
/**
 * GET /api/fees/configurations
 * Get all fee configurations (admin only)
 */
router.get(
  "/configurations",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("LIST_CONFIGURATIONS"),
  async (req: Request, res: Response) => {
    try {
      const configurations = await feeService.getAllConfigurations();

      res.json({
        success: true,
        data: configurations,
      });
    } catch (error: any) {
      console.error("Get configurations error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch fee configurations",
        {
          success: false,
          error: "Failed to fetch fee configurations",
        },
      );
    }
  },
);

/**
 * GET /api/fees/configurations/active
 * Get active fee configuration
 */
router.get("/configurations/active", async (req: Request, res: Response) => {
  try {
    const activeConfig = await feeService.getActiveConfiguration();

    res.json({
      success: true,
      data: activeConfig,
    });
  } catch (error: any) {
    console.error("Get active configuration error:", error);
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to fetch fee configurations",
      {
        success: false,
        error: "Failed to fetch fee configurations",
      },
    );
  }
});

/**
 * GET /api/fees/configurations/:id
 * Get fee configuration by ID (admin only)
 */
router.get(
  "/configurations/:id",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("GET_CONFIGURATION"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const configuration = await feeService.getConfigurationById(id);

      if (!configuration) {
        throw createError(
          ERROR_CODES.NOT_FOUND,
          "Fee configuration not found",
          {
            success: false,
            error: "Fee configuration not found",
          },
        );
      }

      res.json({
        success: true,
        data: configuration,
      });
    } catch (error: any) {
      console.error("Get configuration error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch fee configuration",
        {
          success: false,
          error: "Failed to fetch fee configuration",
        },
      );
    }
  },
);
/**
 * POST /api/fees/configurations
 * Create new fee configuration (admin only)
 */
router.post(
  "/configurations",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("CREATE_CONFIGURATION"),
  async (req: Request, res: Response) => {
    try {
      const data = createFeeConfigSchema.parse(
        req.body,
      ) as CreateFeeConfigRequest;

      const configuration = await feeService.createConfiguration(
        data,
        req.jwtUser!.userId,
      );

      res.status(201).json({
        success: true,
        data: configuration,
      });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          success: false,
          error: "Validation error",
          details: error.errors,
        });
      }

      if (error.code === "23505") {
        // Unique constraint violation
        throw createError(
          ERROR_CODES.CONFLICT,
          "Fee configuration with this name already exists",
          {
            success: false,
            error: "Fee configuration with this name already exists",
          },
        );
      }

      console.error("Create configuration error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to create fee configuration",
        {
          success: false,
          error: "Failed to create fee configuration",
        },
      );
    }
  },
);

/**
 * PUT /api/fees/configurations/:id
 * Update fee configuration (admin only)
 */
router.put(
  "/configurations/:id",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("UPDATE_CONFIGURATION"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data = updateFeeConfigSchema.parse(
        req.body,
      ) as UpdateFeeConfigRequest;

      const configuration = await feeService.updateConfiguration(
        id,
        data,
        req.jwtUser!.userId,
        req.ip,
        req.get("User-Agent"),
      );

      if (!configuration) {
        return res.status(404).json({
          success: false,
          error: "Fee configuration not found",
        });
      }

      res.json({
        success: true,
        data: configuration,
      });
    } catch (error: any) {
      if (error.name === "ZodError") {
        throw createError(ERROR_CODES.INVALID_INPUT, "Validation error", {
          success: false,
          error: "Validation error",
          details: error.errors,
        });
      }

      console.error("Update configuration error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to update fee configuration",
        {
          success: false,
          error: "Failed to update fee configuration",
        },
      );
    }
  },
);
/**
 * DELETE /api/fees/configurations/:id
 * Delete fee configuration (admin only)
 */
router.delete(
  "/configurations/:id",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("DELETE_CONFIGURATION"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const deleted = await feeService.deleteConfiguration(
        id,
        req.jwtUser!.userId,
        req.ip,
        req.get("User-Agent"),
      );

      if (!deleted) {
        throw createError(
          ERROR_CODES.NOT_FOUND,
          "Fee configuration not found",
          {
            success: false,
            error: "Fee configuration not found",
          },
        );
      }

      res.json({
        success: true,
        message: "Fee configuration deleted successfully",
      });
    } catch (error: any) {
      if (error.message === "Cannot delete active fee configuration") {
        throw createError(ERROR_CODES.INVALID_INPUT, error.message, {
          success: false,
          error: error.message,
        });
      }

      console.error("Delete configuration error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to delete fee configuration",
        {
          success: false,
          error: "Failed to delete fee configuration",
        },
      );
    }
  },
);

/**
 * POST /api/fees/configurations/:id/activate
 * Activate fee configuration (admin only)
 */
router.post(
  "/configurations/:id/activate",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("ACTIVATE_CONFIGURATION"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const configuration = await feeService.activateConfiguration(
        id,
        req.jwtUser!.userId,
        req.ip,
        req.get("User-Agent"),
      );

      if (!configuration) {
        throw createError(
          ERROR_CODES.NOT_FOUND,
          "Fee configuration not found",
          {
            success: false,
            error: "Fee configuration not found",
          },
        );
      }

      res.json({
        success: true,
        data: configuration,
        message: "Fee configuration activated successfully",
      });
    } catch (error: any) {
      console.error("Activate configuration error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to activate fee configuration",
        {
          success: false,
          error: "Failed to activate fee configuration",
        },
      );
    }
  },
);
/**
 * GET /api/fees/configurations/:id/audit
 * Get audit history for fee configuration (admin only)
 */
router.get(
  "/configurations/:id/audit",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("GET_AUDIT_HISTORY"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const auditHistory = await feeService.getAuditHistory(id);

      res.json({
        success: true,
        data: auditHistory,
      });
    } catch (error: any) {
      console.error("Get audit history error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch audit history",
        {
          success: false,
          error: "Failed to fetch audit history",
        },
      );
    }
  },
);

/**
 * POST /api/fees/cache/invalidate
 * Manually invalidate all fee configuration caches (admin only)
 */
router.post(
  "/cache/invalidate",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("CACHE_INVALIDATE"),
  async (_req: Request, res: Response) => {
    try {
      await layeredCache.invalidateAll();
      const version = await layeredCache.bumpVersion();

      res.json({
        success: true,
        message: "All fee configuration caches invalidated",
        version,
      });
    } catch (error: any) {
      console.error("Cache invalidation error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to invalidate fee caches",
        {
          success: false,
          error: "Failed to invalidate fee caches",
        },
      );
    }
  },
);

/**
 * GET /api/fees/cache/metrics
 * Get cache hit/miss metrics (admin only)
 */
router.get(
  "/cache/metrics",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("CACHE_METRICS"),
  async (_req: Request, res: Response) => {
    try {
      const metrics = layeredCache.getMetrics();
      const version = await layeredCache.getVersion();

      res.json({
        success: true,
        data: { ...metrics, version },
      });
    } catch (error: any) {
      console.error("Cache metrics error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch cache metrics",
        {
          success: false,
          error: "Failed to fetch cache metrics",
        },
      );
    }
  },
);

/**
 * GET /api/fees/audit
 * Retrieve paginated fee calculation audit records (admin only).
 * Query params: transactionId, userId, provider, strategyId, from, to, limit, offset
 */
router.get(
  "/audit",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("GET_FEE_AUDIT"),
  async (req: Request, res: Response) => {
    try {
      const {
        transactionId,
        userId,
        provider,
        strategyId,
        from,
        to,
        limit,
        offset,
      } = req.query as Record<string, string | undefined>;

      const filters = {
        transactionId: transactionId || undefined,
        userId: userId || undefined,
        provider: provider || undefined,
        strategyId: strategyId || undefined,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      };

      const { records, total } = await feeAuditService.getAuditRecords(filters);

      res.json({
        success: true,
        data: records,
        pagination: {
          total,
          limit: filters.limit ?? 50,
          offset: filters.offset ?? 0,
        },
      });
    } catch (error: any) {
      console.error("Fee audit fetch error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch fee audit records",
        {
          success: false,
          error: "Failed to fetch fee audit records",
        },
      );
    }
  },
);

/**
 * GET /api/fees/sep6/breakdown
 * Get SEP-6 fee breakdown and analytics (admin only).
 * Query params: from, to, assetCode, limit, offset
 * 
 * Returns aggregated fee revenue by asset code, transaction type, and time period.
 */
router.get(
  "/sep6/breakdown",
  authenticateToken,
  requirePermission("admin:system"),
  logFeeAction("GET_SEP6_FEE_BREAKDOWN"),
  async (req: Request, res: Response) => {
    try {
      const { from, to, assetCode, limit = "50", offset = "0" } = req.query as Record<string, string | undefined>;

      const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // default: last 30 days
      const toDate = to ? new Date(to) : new Date();
      const pageLimit = Math.min(parseInt(limit || "50", 10), 1000);
      const pageOffset = parseInt(offset || "0", 10);

      // Query fee audit records for SEP-6
      const { records, total } = await feeAuditService.getAuditRecords({
        provider: "sep6",
        from: fromDate,
        to: toDate,
        limit: pageLimit,
        offset: pageOffset,
      });

      // Aggregate fees by asset code and transaction type
      const breakdown: Record<string, any> = {
        totalRecords: total,
        dateRange: { from: fromDate.toISOString(), to: toDate.toISOString() },
        summary: {
          totalFeeRevenue: 0,
          totalTransactionVolume: 0,
          averageFeePercentage: 0,
          averageFlatFee: 0,
          totalTransactions: records.length,
        },
        byAsset: {} as Record<string, any>,
        byType: {} as Record<string, any>,
        records: records.slice(0, 10), // Include first 10 detailed records
      };

      for (const record of records) {
        breakdown.summary.totalFeeRevenue += record.calculatedFee;
        breakdown.summary.totalTransactionVolume += record.inputAmount;

        // Extract asset code from strategyId (format: sep6_XLM)
        const [, asset] = record.strategyId.split("_");
        if (asset) {
          if (!breakdown.byAsset[asset]) {
            breakdown.byAsset[asset] = {
              asset,
              feeRevenue: 0,
              transactionVolume: 0,
              count: 0,
              avgFeePercentage: 0,
            };
          }
          breakdown.byAsset[asset].feeRevenue += record.calculatedFee;
          breakdown.byAsset[asset].transactionVolume += record.inputAmount;
          breakdown.byAsset[asset].count += 1;
          if (record.feePercentage) {
            breakdown.byAsset[asset].avgFeePercentage = record.feePercentage;
          }
        }

        // Extract transaction type from strategyName (format: "SEP-6 XLM Deposit" or "... Withdrawal")
        const txType = record.strategyName.includes("Withdrawal") ? "withdrawal" : "deposit";
        if (!breakdown.byType[txType]) {
          breakdown.byType[txType] = {
            type: txType,
            feeRevenue: 0,
            transactionVolume: 0,
            count: 0,
          };
        }
        breakdown.byType[txType].feeRevenue += record.calculatedFee;
        breakdown.byType[txType].transactionVolume += record.inputAmount;
        breakdown.byType[txType].count += 1;
      }

      // Calculate averages
      if (records.length > 0) {
        breakdown.summary.averageFeePercentage =
          records.reduce((sum, r) => sum + (r.feePercentage || 0), 0) / records.length;
        breakdown.summary.averageFlatFee =
          records.reduce((sum, r) => sum + (r.flatAmount || 0), 0) / records.length;
      }

      // Apply asset filter if provided
      if (assetCode) {
        breakdown.records = breakdown.records.filter((r: any) =>
          r.strategyId.includes(`_${assetCode}`)
        );
        breakdown.byAsset = assetCode in breakdown.byAsset ? { [assetCode]: breakdown.byAsset[assetCode] } : {};
      }

      res.json({
        success: true,
        data: breakdown,
        pagination: {
          total,
          limit: pageLimit,
          offset: pageOffset,
        },
      });
    } catch (error: any) {
      console.error("SEP-6 fee breakdown fetch error:", error);
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch SEP-6 fee breakdown",
        {
          success: false,
          error: "Failed to fetch SEP-6 fee breakdown",
        },
      );
    }
  },
);

export default router;
