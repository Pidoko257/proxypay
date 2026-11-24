import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger";

export class ForbiddenError extends Error {
  public statusCode = 403;
  constructor(message: string = "Access denied: resource belongs to another tenant or owner") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Verify whether an authenticated principal owns a resource or possesses an
 * overriding administrative role.
 */
export function verifyResourceOwnership(
  principalId: string | undefined,
  resourceOwnerId: string | undefined,
  options: {
    principalRole?: string;
    superRoles?: string[];
  } = {}
): boolean {
  if (!principalId || !resourceOwnerId) return false;

  const superRoles = options.superRoles || ["admin", "superadmin", "compliance"];
  if (options.principalRole && superRoles.includes(options.principalRole.toLowerCase())) {
    return true;
  }

  return principalId === resourceOwnerId;
}

/**
 * Assert ownership, throwing ForbiddenError if ownership check fails.
 */
export function assertResourceOwnership(
  principalId: string | undefined,
  resourceOwnerId: string | undefined,
  resourceType: string,
  resourceId: string,
  options: {
    principalRole?: string;
    superRoles?: string[];
  } = {}
): void {
  if (!verifyResourceOwnership(principalId, resourceOwnerId, options)) {
    logger.warn(
      `[TenantIsolation] Unauthorized cross-tenant access attempt by principal '${principalId}' on ${resourceType} '${resourceId}' owned by '${resourceOwnerId}'`
    );
    throw new ForbiddenError(`Access denied: you do not have permission to access this ${resourceType}`);
  }
}

/**
 * Middleware factory to enforce resource ownership on Express requests.
 */
export function requireOwnership(
  getResourceOwnerId: (req: Request) => Promise<string | null | undefined> | string | null | undefined,
  resourceType: string
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      if (!user?.id) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const ownerId = await getResourceOwnerId(req);
      if (!ownerId) {
        return res.status(404).json({ error: `${resourceType} not found` });
      }

      assertResourceOwnership(user.id, ownerId, resourceType, req.params.id || "unspecified", {
        principalRole: user.role,
      });

      next();
    } catch (err: any) {
      if (err instanceof ForbiddenError) {
        return res.status(403).json({ error: err.message });
      }
      next(err);
    }
  };
}
