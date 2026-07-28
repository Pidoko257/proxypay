import { NextFunction, Request, Response } from "express";

export interface AuditContext {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    auditContext?: Pick<AuditContext, "ipAddress" | "userAgent">;
  }
}

export function auditContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  req.auditContext = {
    ipAddress: req.ip,
    userAgent: req.get("user-agent") ?? undefined,
  };
  next();
}

export function getAuditContext(req: Request, userId?: string): AuditContext {
  const authenticatedUserId = req.jwtUser?.userId ?? req.user?.id ?? userId;

  if (!authenticatedUserId) {
    throw new Error("Authenticated user is required for audit logging");
  }

  return {
    userId: authenticatedUserId,
    ipAddress: req.auditContext?.ipAddress ?? req.ip,
    userAgent:
      req.auditContext?.userAgent ?? req.get("user-agent") ?? undefined,
  };
}
