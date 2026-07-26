import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  organizationSettingsService,
  UpdateOrganizationSettingsRequest,
} from "../services/organizationSettingsService";
import { requireAuth } from "../middleware/auth";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

router.use(requireAuth);

const updateSettingsSchema = z.object({
  defaultCurrency: z.string().min(1).max(10).optional(),
  paymentNotificationEnabled: z.boolean().optional(),
  paymentNotificationUrl: z.string().url().nullable().optional(),
  ipAllowlist: z.array(z.string()).optional(),
  customFeeTierOverride: z.record(z.any()).optional(),
});

/**
 * GET /api/organization/settings
 * Returns the full settings object for the requesting organization.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const organizationId = extractOrganizationId(req);
    if (!organizationId) {
      throw createError(
        ERROR_CODES.MISSING_FIELD,
        "organizationId is required",
      );
    }

    const settings = await organizationSettingsService.getOrCreateSettings(
      organizationId,
      req.user?.id || req.jwtUser?.userId || "system",
    );

    res.json({
      success: true,
      data: settings,
    });
  } catch (error: any) {
    if (error.code) throw error;
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to fetch organization settings",
    );
  }
});

/**
 * PATCH /api/organization/settings
 * Partial update of organization settings. Changes are logged to the audit
 * trail with before/after values.
 */
router.patch("/", async (req: Request, res: Response) => {
  try {
    const organizationId = extractOrganizationId(req);
    if (!organizationId) {
      throw createError(
        ERROR_CODES.MISSING_FIELD,
        "organizationId is required",
      );
    }

    const data = updateSettingsSchema.parse(
      req.body,
    ) as UpdateOrganizationSettingsRequest;
    const userId = req.user?.id || req.jwtUser?.userId || "system";

    const settings = await organizationSettingsService.updateSettings(
      organizationId,
      data,
      userId,
      req.ip,
      req.get("User-Agent"),
    );

    if (!settings) {
      throw createError(
        ERROR_CODES.NOT_FOUND,
        "Organization settings not found",
      );
    }

    res.json({
      success: true,
      data: settings,
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
      "Failed to update organization settings",
    );
  }
});

/**
 * GET /api/organization/settings/audit
 * Returns the audit trail for organization settings changes.
 */
router.get("/audit", async (req: Request, res: Response) => {
  try {
    const organizationId = extractOrganizationId(req);
    if (!organizationId) {
      throw createError(
        ERROR_CODES.MISSING_FIELD,
        "organizationId is required",
      );
    }

    const auditHistory =
      await organizationSettingsService.getAuditHistory(organizationId);

    res.json({
      success: true,
      data: auditHistory,
    });
  } catch (error: any) {
    if (error.code) throw error;
    throw createError(
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to fetch organization settings audit history",
    );
  }
});

/**
 * Extract organizationId from query param, JWT, or user context.
 * Supports: ?organizationId=xxx, req.jwtUser.userId, req.user.id
 */
function extractOrganizationId(req: Request): string | null {
  const fromQuery = req.query.organizationId;
  if (typeof fromQuery === "string" && fromQuery.length > 0) {
    return fromQuery;
  }

  const fromJwt = req.jwtUser?.userId;
  if (fromJwt) return fromJwt;

  const fromUser = (req as any).user?.id;
  if (fromUser) return fromUser;

  return null;
}

export default router;
