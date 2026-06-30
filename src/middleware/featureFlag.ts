import { Request, Response, NextFunction } from "express";
import { getFeatureFlag } from "../services/featureFlagService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "./errorHandler";

function resolveOrganizationId(req: Request): string | null {
  if ((req as any).user?.id) {
    return (req as any).user.id;
  }
  if ((req as any).jwtUser?.userId) {
    return (req as any).jwtUser.userId;
  }
  return null;
}

export function requireFeature(flagName: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const organizationId = resolveOrganizationId(req);

      if (!organizationId) {
        throw createError(
          ERROR_CODES.UNAUTHORIZED,
          "Authentication required to check feature flag",
        );
      }

      const enabled = await getFeatureFlag(organizationId, flagName);

      if (!enabled) {
        throw createError(
          ERROR_CODES.FEATURE_NOT_ENABLED,
          `Feature "${flagName}" is not enabled for your organization`,
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
