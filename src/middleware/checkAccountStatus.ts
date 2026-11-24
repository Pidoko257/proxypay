import { Request, Response, NextFunction } from "express";
import { UserModel } from "../models/users";
import logger from "../utils/logger";

const userModel = new UserModel();

/**
 * Custom error class for frozen/suspended account
 */
export class AccountStatusError extends Error {
  constructor(
    public status: "frozen" | "suspended",
    message: string = `Account is ${status}`
  ) {
    super(message);
    this.name = "AccountStatusError";
  }
}

/**
 * Helper to log suspicious activity from restricted accounts
 */
function logSuspiciousActivity(
  userId: string,
  userStatus: "frozen" | "suspended",
  req: Request,
  severity: "warn" | "error" = "warn"
): void {
  const logData = {
    event: "SUSPICIOUS_ACTIVITY_FROM_RESTRICTED_ACCOUNT",
    userId,
    accountStatus: userStatus,
    method: req.method,
    path: req.originalUrl,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
    referer: req.get("referer"),
  };

  if (severity === "error") {
    logger.error(logData, `Blocked request from ${userStatus} account`);
  } else {
    logger.warn(logData, `Attempted request from ${userStatus} account`);
  }
}

/**
 * Returns true when the user exists and their account is active (not frozen,
 * suspended or soft-deactivated). Used for long-lived connections that outlive
 * a single HTTP request (WebSocket / GraphQL subscriptions, issue #814).
 */
export async function isAccountActive(userId: string): Promise<boolean> {
  const user = await userModel.findById(userId);
  return !!user && user.status === "active" && user.isActive !== false;
}

/**
 * Middleware to check if user account is frozen or suspended
 * This middleware should be called after authentication middleware
 * to ensure req.jwtUser is available
 *
 * This variant logs and continues on database errors (best-effort checking)
 */
export async function checkAccountStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get user ID from JWT token (set by authenticateToken middleware)
    const userId = req.jwtUser?.userId;

    if (!userId) {
      // No user ID in token, skip this check
      // (authentication middleware will handle this)
      next();
      return;
    }

    // Fetch user from database to check current status
    const user = await userModel.findById(userId);

    if (!user) {
      logger.warn({ userId, method: req.method, path: req.originalUrl }, "User not found during status check");
      res.status(401).json({
        error: "User not found",
        message: "User account does not exist",
      });
      return;
    }

    // Check if account is frozen or suspended
    if (user.status === "frozen") {
      logSuspiciousActivity(userId, "frozen", req, "error");

      res.status(403).json({
        error: "Account frozen",
        message: "Your account has been frozen. Please contact support.",
        status: user.status,
      });
      return;
    }

    if (user.status === "suspended") {
      logSuspiciousActivity(userId, "suspended", req, "error");

      res.status(403).json({
        error: "Account suspended",
        message: "Your account has been suspended. Please contact support.",
        status: user.status,
      });
      return;
    }

    // Account is active, proceed
    next();
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), userId: req.jwtUser?.userId },
      "Error checking account status"
    );
    // Don't block request on error, just log it (best-effort checking)
    next();
  }
}

/**
 * Middleware to check if user account is frozen or suspended
 * for transaction-related endpoints (deposits/withdrawals)
 * This variant fails closed on errors to ensure transaction safety
 */
export async function checkAccountStatusStrict(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.jwtUser?.userId;

    if (!userId) {
      res.status(401).json({
        error: "Authentication required",
        message: "User must be authenticated to perform this action",
      });
      return;
    }

    const user = await userModel.findById(userId);

    if (!user) {
      logger.error({ userId }, "User not found - cannot verify account status for transaction");
      res.status(401).json({
        error: "User not found",
        message: "User account does not exist",
      });
      return;
    }

    if (user.status !== "active") {
      logSuspiciousActivity(userId, user.status as "frozen" | "suspended", req, "error");

      const errorMessage = user.status === "frozen"
        ? "Your account has been frozen. All deposits and withdrawals are blocked."
        : "Your account has been suspended. All deposits and withdrawals are blocked.";

      res.status(403).json({
        error: `Account ${user.status}`,
        message: errorMessage,
        status: user.status,
      });
      return;
    }

    next();
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), userId: req.jwtUser?.userId },
      "Error checking account status for transaction - failing closed"
    );
    // Fail closed for transaction-related endpoints
    res.status(500).json({
      error: "Internal server error",
      message: "Unable to verify account status",
    });
  }
}
