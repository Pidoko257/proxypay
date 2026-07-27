import { Request, Response, NextFunction } from "express";
import { twoFactorAuthService } from "../services/twoFactorAuthService";

export interface TwoFactorEnforcementOptions {
  enforceForRoles?: string[];
  skipIfTrustedDevice?: boolean;
}

export function requireTwoFactor(options: TwoFactorEnforcementOptions = {}) {
  const { enforceForRoles = ["admin", "super-admin", "merchant"], skipIfTrustedDevice = true } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as Request & { user?: { id?: string; role?: string } };
    const userId = authReq.user?.id;
    const userRole = authReq.user?.role?.toLowerCase() || "";

    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!enforceForRoles.includes(userRole)) {
      return next();
    }

    const status = await twoFactorAuthService.getTwoFactorStatus(userId);
    if (!status.enabled) {
      res.status(403).json({
        error: "Two-factor authentication required",
        message: "Enable two-factor authentication to access this resource",
        requiresTwoFactor: true,
      });
      return;
    }

    const verified = req.headers["x-2fa-verified"] === "true";
    const twoFactorDeviceId = req.headers["x-2fa-device-id"] as string | undefined;

    if (skipIfTrustedDevice && twoFactorDeviceId) {
      const isTrusted = await twoFactorAuthService.isDeviceTrusted(userId, twoFactorDeviceId);
      if (isTrusted) {
        return next();
      }
    }

    if (!verified) {
      res.status(403).json({
        error: "Two-factor authentication required",
        message: "Verify with your two-factor authentication to continue",
        requiresTwoFactor: true,
        methods: status.methods.filter((m) => m.enabled).map((m) => m.type),
      });
      return;
    }

    next();
  };
}

export async function enforceTwoFactorForSensitiveActions(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authReq = req as Request & { user?: { id?: string; role?: string } };
  const userId = authReq.user?.id;

  if (!userId) {
    return next();
  }

  const sensitivePaths = ["/api/admin", "/api/users/2fa/withdrawals"];
  const isSensitive = sensitivePaths.some((path) => req.originalUrl.startsWith(path));
  if (!isSensitive) {
    return next();
  }

  const status = await twoFactorAuthService.getTwoFactorStatus(userId);
  if (!status.enabled) {
    return next();
  }

  const verified = req.headers["x-2fa-verified"] === "true";
  if (!verified) {
    res.setHeader("X-2FA-Required", "true");
  }

  next();
}
