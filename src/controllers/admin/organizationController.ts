import { Request, Response, NextFunction } from "express";
import { OrganizationModel } from "../../models/organization";
import { ERROR_CODES } from "../../constants/errorCodes";
import { createError } from "../../middleware/errorHandler";
import { addOrganizationCleanupJob } from "../../queue/organizationCleanupQueue";
import { auditService } from "../../services/auditlogService";

const organizationModel = new OrganizationModel();

interface AdminRequest extends Request {
  user?: {
    id: string;
    role: string;
  };
}

export const listOrganizations = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const search = (req.query.search as string) || undefined;

    const result = await organizationModel.findAll(page, limit, search);

    await auditService.logPIIAccess({
      adminId: (req as AdminRequest).user?.id || "unknown",
      targetId: "organizations",
      resource: "organizations",
      metadata: { action: "LIST", page, limit, search },
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
};

export const getOrganization = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;

    const org = await organizationModel.findById(id);

    if (!org) {
      throw createError(ERROR_CODES.NOT_FOUND, "Organization not found", {
        message: "Organization not found",
      });
    }

    await auditService.logPIIAccess({
      adminId: (req as AdminRequest).user?.id || "unknown",
      targetId: id,
      resource: "organizations",
      metadata: { action: "GET", organizationId: id },
    });

    res.json(org);
  } catch (err) {
    next(err);
  }
};

export const suspendOrganization = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const adminUser = (req as AdminRequest).user;

    if (!adminUser) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required", {
        message: "Authentication required",
      });
    }

    const org = await organizationModel.findById(id);

    if (!org) {
      throw createError(ERROR_CODES.NOT_FOUND, "Organization not found", {
        message: "Organization not found",
      });
    }

    if (org.status === "suspended") {
      throw createError(ERROR_CODES.CONFLICT, "Organization is already suspended", {
        message: "Organization is already suspended",
      });
    }

    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    const updatedOrg = await organizationModel.updateStatus(
      id,
      "suspended",
      adminUser.id,
      reason || "Suspended by admin",
      req.ip,
      req.get("user-agent"),
    );

    if (!updatedOrg) {
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to suspend organization", {
        message: "Failed to suspend organization",
      });
    }

    await organizationModel.suspendApiKeys(id);

    await organizationModel.logAuditEvent(
      id,
      "ORG_SUSPEND",
      adminUser.id,
      { reason, apiKeysDisabled: true },
      req.ip,
      req.get("user-agent"),
    );

    res.json({
      message: "Organization suspended successfully",
      organization: updatedOrg,
      apiKeysDisabled: true,
    });
  } catch (err) {
    next(err);
  }
};

export const deleteOrganization = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const adminUser = (req as AdminRequest).user;

    if (!adminUser) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required", {
        message: "Authentication required",
      });
    }

    const org = await organizationModel.findById(id);

    if (!org) {
      throw createError(ERROR_CODES.NOT_FOUND, "Organization not found", {
        message: "Organization not found",
      });
    }

    if (org.status === "deleted") {
      throw createError(ERROR_CODES.CONFLICT, "Organization is already deleted", {
        message: "Organization is already deleted",
      });
    }

    await organizationModel.updateStatus(
      id,
      "deleted",
      adminUser.id,
      "Organization deleted by admin",
      req.ip,
      req.get("user-agent"),
    );

    await addOrganizationCleanupJob(id, adminUser.id);

    await organizationModel.logAuditEvent(
      id,
      "ORG_DELETE_INITIATED",
      adminUser.id,
      { cleanupQueued: true },
      req.ip,
      req.get("user-agent"),
    );

    res.json({
      message: "Organization deletion initiated. A confirmation email will be sent upon completion.",
      organizationId: id,
      status: "cleanup_queued",
    });
  } catch (err) {
    next(err);
  }
};