import { Router, Request, Response, NextFunction } from "express";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import {
  getFeatureFlag,
  setFeatureFlag,
  deleteFeatureFlag,
  getAllFeatureFlags,
} from "../services/featureFlagService";

const router = Router();

interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
    [key: string]: unknown;
  };
}

function isAdmin(user: { role: string } | undefined): boolean {
  return user?.role === "admin";
}

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    if (!isAdmin(authReq.user)) {
      throw createError(ERROR_CODES.FORBIDDEN, "Admin access required");
    }

    const { organizationId } = req.query as { organizationId?: string };
    if (!organizationId) {
      throw createError(ERROR_CODES.INVALID_INPUT, "organizationId query parameter is required");
    }

    const flags = await getAllFeatureFlags(organizationId);
    res.json({ flags });
  } catch (err) {
    next(err);
  }
});

router.put("/:flagName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    if (!isAdmin(authReq.user)) {
      throw createError(ERROR_CODES.FORBIDDEN, "Admin access required");
    }

    const { flagName } = req.params;
    const { organizationId, enabled } = req.body as {
      organizationId: string;
      enabled: boolean;
    };

    if (!organizationId) {
      throw createError(ERROR_CODES.INVALID_INPUT, "organizationId is required in request body");
    }
    if (typeof enabled !== "boolean") {
      throw createError(ERROR_CODES.INVALID_INPUT, "enabled must be a boolean");
    }

    await setFeatureFlag(organizationId, flagName, enabled);

    const current = await getFeatureFlag(organizationId, flagName);
    res.json({ flagName, organizationId, enabled: current });
  } catch (err) {
    next(err);
  }
});

router.delete("/:flagName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthRequest;
    if (!isAdmin(authReq.user)) {
      throw createError(ERROR_CODES.FORBIDDEN, "Admin access required");
    }

    const { flagName } = req.params;
    const { organizationId } = req.body as { organizationId: string };

    if (!organizationId) {
      throw createError(ERROR_CODES.INVALID_INPUT, "organizationId is required in request body");
    }

    await deleteFeatureFlag(organizationId, flagName);
    res.json({ message: `Feature flag "${flagName}" deleted for organization ${organizationId}` });
  } catch (err) {
    next(err);
  }
});

export default router;
