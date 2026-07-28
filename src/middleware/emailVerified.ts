import { Request, Response, NextFunction } from "express";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "./errorHandler";
import { queryRead } from "../config/database";

/**
 * Middleware that enforces the email-verified gate for protected endpoints.
 *
 * Returns:
 *  - 401 if the request is not authenticated (`authenticateToken` should run
 *    before this — fail closed).
 *  - 403 with `code: EMAIL_UNVERIFIED` and `details.error: ERR_EMAIL_UNVERIFIED`
 *    when the authenticated user's email is not yet verified.
 *
 * Pairs naturally with `authenticateToken`. Resilience to a missing
 * `email_verified` column (e.g. on pre-migration environments) is
 * intentional: if the column is not yet present we treat the user as
 * unverified and let downstream behaviour degrade safely.
 */
export async function requireVerifiedEmail(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.jwtUser?.userId;
  if (!userId) {
    next(
      createError(ERROR_CODES.UNAUTHORIZED, "Authentication required", {
        error: "UNAUTHORIZED",
      }),
    );
    return;
  }

  try {
    const result = await queryRead(
      `SELECT email_verified
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [userId],
    );

    if (result.rows.length === 0) {
      next(
        createError(ERROR_CODES.UNAUTHORIZED, "User not found", {
          error: "UNAUTHORIZED",
        }),
      );
      return;
    }

    const verified = result.rows[0]?.email_verified;

    if (verified !== true) {
      next(
        createError(ERROR_CODES.EMAIL_UNVERIFIED, "Email not verified", {
          error: "ERR_EMAIL_UNVERIFIED",
        }),
      );
      return;
    }

    next();
  } catch (error: any) {
    // If the migration has not been applied yet (`42703` = undefined_column)
    // and the env looks like a pre-production database, fall through with a
    // warning rather than blocking everyone. Production environments are
    // expected to have the migration applied.
    if (error?.code === "42703") {
      console.warn(
        "[requireVerifiedEmail] email_verified column missing — assuming not verified",
      );
      next(
        createError(ERROR_CODES.EMAIL_UNVERIFIED, "Email not verified", {
          error: "ERR_EMAIL_UNVERIFIED",
        }),
      );
      return;
    }

    next(error);
  }
}
