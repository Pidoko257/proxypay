import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  generateToken,
  verifyToken,
  JWTPayload,
  generateRefreshToken,
  verifyRefreshToken,
} from "../auth/jwt";
import { createSSORouter } from "../auth/sso";
import { createOIDCRouter, initializeOIDCProviders } from "../auth/oidc";
import { enforceSSOForEmployees } from "../middleware/ssoEnforcement";
import { tokenController } from "../controllers/tokenController";
import { authenticateToken } from "../middleware/auth";
import {
  authenticateUser,
  createUser,
  getUserPermissions,
  getUserByPhoneNumber,
  User,
} from "../services/userService";
import { getLockoutStatus, recordFailedAttempt } from "../auth/lockout";
import { verifyTOTPToken, verifyBackupCode, is2FAEnabled } from "../auth/2fa";
import { evaluateAdminLoginAnomaly } from "../services/loginAnomaly";
import { validateRequest } from "../middleware/validation";
import { hashPassword } from "../utils/password";
import { redisClient } from "../config/redis";
import { TransactionModel } from "../models/transaction";
import { EmailService } from "../services/email";
import {
  loginRateLimiter,
  registerRateLimiter,
} from "../middleware/authRateLimit";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import {
  issueEmailVerificationToken,
  consumeEmailVerificationToken,
} from "../auth/emailVerification";
import { requireVerifiedEmail } from "../middleware/emailVerified";
import { queryWrite, queryRead } from "../config/database";
import { encrypt } from "../utils/encryption";

const emailService = new EmailService();

export const authRoutes = Router();

export const registerSchema = z.object({
  phone_number: z.string().min(1, "phone_number is required"),
  email: z.string().email("A valid email address is required"),
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number")
    .regex(
      /[^A-Za-z0-9]/,
      "Password must contain at least one special character",
    ),
});

/**
 * POST /api/auth/register
 */
authRoutes.post(
  "/register",
  registerRateLimiter,
  validateRequest(registerSchema),
  async (req: Request, res: Response) => {
    const { phone_number, email, password } = req.body as z.infer<
      typeof registerSchema
    >;
    try {
      const passwordHash = await hashPassword(password);
      const user = await createUser({
        phone_number,
        email,
        password_hash: passwordHash,
      } as any);

      const { token: verificationToken } =
        await issueEmailVerificationToken(user.id);

      const baseUrl =
        process.env.EMAIL_VERIFICATION_BASE_URL ||
        `${req.protocol}://${req.get("host")}`;
      const verificationLink = `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`;

      try {
        await emailService.sendEmailVerification(email, {
          verificationLink,
          expiresInHours: 24,
        });
      } catch (emailErr) {
        console.error("[Register] Failed to send verification email:", emailErr);
      }

      res
        .status(201)
        .json({ message: "User registered successfully", userId: user.id });
    } catch (error) {
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Registration failed", {
        error: "Registration failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

// Initialize OIDC Strategy (Google/Azure)
initializeOIDCProviders();

// Mount SSO routes
authRoutes.use("/sso", createSSORouter());
authRoutes.use("/sso/oidc", createOIDCRouter());

/**
 * POST /api/auth/login
 *
 * Authenticates a user and returns JWT + refresh token.
 * Enforces account lockout after 5 failed attempts within 10 minutes.
 * Sends an email notification when an account is locked.
 */
authRoutes.post(
  "/login",
  loginRateLimiter,
  async (req: Request, res: Response) => {
    const { phone_number } = req.body;

    if (!phone_number) {
      throw createError(ERROR_CODES.MISSING_FIELD, "phone_number is required", {
        error: "Missing required fields",
      });
    }

    // Use the phone number as the lockout identifier.
    const lockoutId = phone_number;

    try {
      // ── 1. Gate: reject immediately if the account is already locked ──────────
      const lockoutStatus = await getLockoutStatus(lockoutId);
      if (lockoutStatus.isLocked) {
        throw createError(
          ERROR_CODES.LIMIT_EXCEEDED,
          `Your account is temporarily locked. ` +
            `Please try again in ${lockoutStatus.minutesRemaining} minute${lockoutStatus.minutesRemaining === 1 ? "" : "s"}.`,
          {
            unlocksAt: lockoutStatus.unlocksAt,
            minutesRemaining: lockoutStatus.minutesRemaining,
            error: "ACCOUNT_LOCKED",
          },
        );
      }

      // ── 2. Attempt authentication ─────────────────────────────────────────────
      const user = await authenticateUser(phone_number);

      if (!user) {
        // ── 3a. Authentication failed: record the attempt ──────────────────────
        const result = await recordFailedAttempt(lockoutId);

        if (result.justLocked) {
          // ── 3b. Account just got locked: send notification email ───────────
          // Best-effort: look up the user's email to notify them.
          try {
            const userRecord = await getUserByPhoneNumber(phone_number);
            const userEmail = (userRecord as any)?.email as string | undefined;
            if (userEmail) {
              void emailService.sendAccountLockoutNotification(userEmail, {
                minutesRemaining: result.lockoutStatus.minutesRemaining ?? 30,
                unlocksAt: result.lockoutStatus.unlocksAt ?? new Date(),
                ipAddress: req.ip,
              });
            }
          } catch (emailErr) {
            console.error(
              "[Login] Failed to send lockout notification:",
              emailErr,
            );
          }

          throw createError(ERROR_CODES.ACCOUNT_LOCKED, result.message, {
            error: "ACCOUNT_LOCKED",
            unlocksAt: result.lockoutStatus.unlocksAt,
            minutesRemaining: result.lockoutStatus.minutesRemaining,
          });
        }

        throw createError(ERROR_CODES.UNAUTHORIZED, result.message, {
          error: "Unauthorized",
          attemptsRemaining: result.lockoutStatus.attemptsRemaining,
        });
      }

      const anomaly = await evaluateAdminLoginAnomaly(req, user);

      if (anomaly.suspicious) {
        if (!is2FAEnabled(user)) {
          throw createError(
            ERROR_CODES.FORBIDDEN,
            "Anomalous admin login was blocked. Enable two-factor authentication and retry.",
            {
              error: "Suspicious admin login detected",
              requiresTwoFactor: true,
              anomaly: anomaly.reason,
            },
          );
        }

        const twoFactorToken = req.headers["x-2fa-token"] as string | undefined;
        const backupCode = req.body["backupCode"] || req.body["backup_code"];

        let verified2fa = false;

        if (twoFactorToken && user.two_factor_secret) {
          verified2fa = verifyTOTPToken(user.two_factor_secret, twoFactorToken);
        }

        if (!verified2fa && backupCode && user.backup_codes) {
          const backupCodes = user.backup_codes.map((item, index) =>
            typeof item === "string"
              ? {
                  id: String(index),
                  code_hash: item,
                  used: false,
                  created_at: new Date(),
                }
              : item,
          );
          const verification = await verifyBackupCode(backupCode, backupCodes);
          verified2fa = verification.valid;
        }

        if (!verified2fa) {
          throw createError(
            ERROR_CODES.FORBIDDEN,
            "Suspicious admin login detected. Provide X-2FA-Token header or backupCode to continue.",
            {
              error: "Two-factor authentication required",
              requiresTwoFactor: true,
              anomaly: anomaly.reason,
            },
          );
        }
      }

      const payload = {
        userId: user.id,
        email: user.phone_number,
        role: user.role_name || "user",
      };

      const token = generateToken(payload);
      const refreshToken = await generateRefreshToken(user.id);
      const permissions = await getUserPermissions(user.id);

      res.json({
        message: "Login successful",
        token,
        refreshToken,
        user: {
          userId: user.id,
          email: user.phone_number,
          role: user.role_name || "user",
          permissions,
        },
      });
    } catch (error) {
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        error instanceof Error ? error.message : "Unknown error",
        { error: "Token generation failed" },
      );
    }
  },
);

/**
 * POST /api/auth/refresh
 *
 * Rotates refresh token, issues new access and refresh tokens, and enforces strict rotation
 */
authRoutes.post("/refresh", async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    throw createError(ERROR_CODES.MISSING_FIELD, "Refresh token is required", {
      error: "Refresh token is required",
    });
  }
  try {
    // Verify and check for reuse
    const decoded = await verifyRefreshToken(refreshToken);
    // Issue new access and refresh tokens (rotate)
    const token = generateToken({ userId: decoded.userId, email: "" }); // You may want to fetch email if needed
    const newRefreshToken = await generateRefreshToken(
      decoded.userId,
      decoded.familyId,
      decoded.tokenId,
    );
    res.json({
      message: "Token rotation successful",
      token,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    throw createError(
      ERROR_CODES.UNAUTHORIZED,
      error instanceof Error ? error.message : "Unknown error",
      {
        error: "Refresh failed",
      },
    );
  }
});

/**
 * GET /api/auth/tokens
 *
 * List all active refresh token
 */
authRoutes.get(
  "/tokens/active/:family_id",
  authenticateToken,
  tokenController.findAll,
);

/**
 * DELETE /api/auth/tokens
 *
 * Delete all refresh token
 */
authRoutes.delete(
  "/tokens/revoke-all/:family_id",
  authenticateToken,
  tokenController.revokeAll,
);

/**
 * DELETE /api/auth/tokens
 *
 * Delete a specific refresh token
 */
authRoutes.delete(
  "/tokens/:token_id/:family_id",
  authenticateToken,
  tokenController.revoke,
);

/**
 * POST /api/auth/verify
 *
 * Verify a JWT token and return the decoded payload
 */
authRoutes.post("/verify", (req: Request, res: Response) => {
  const { token } = req.body;

  if (!token) {
    throw createError(
      ERROR_CODES.MISSING_FIELD,
      "Token is required for verification",
      {
        error: "Missing token",
      },
    );
  }

  try {
    const payload = verifyToken(token);
    res.json({
      valid: true,
      payload,
    });
  } catch (error) {
    throw createError(
      ERROR_CODES.UNAUTHORIZED,
      error instanceof Error ? error.message : "Unknown error",
      {
        error: "Token verification failed",
      },
    );
  }
});

/**
 * GET /api/auth/verify-email?token=
 *
 * Activates a user account by consuming a time-limited email
 * verification token. The token is a JWT with a 24-hour expiry,
 * stored in Redis for fast single-use validation. On success the
 * `email_verified` flag is set to `true` in the database and the
 * Redis key is deleted.
 */
authRoutes.get("/verify-email", async (req: Request, res: Response) => {
  const raw = req.query.token;

  if (typeof raw !== "string" || raw.length === 0) {
    throw createError(ERROR_CODES.MISSING_FIELD, "Verification token is required", {
      error: "MISSING_TOKEN",
    });
  }

  try {
    const { userId } = await consumeEmailVerificationToken(raw);

    await queryWrite(
      `UPDATE users
          SET email_verified = true,
              email_verified_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [userId],
    );

    res.json({ message: "Email verified successfully", userId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    throw createError(ERROR_CODES.INVALID_TOKEN, message, {
      error: "VERIFICATION_FAILED",
      message,
    });
  }
});

/**
 * POST /api/auth/resend-verification
 *
 * Issues and sends a new verification email to an unverified user.
 * To avoid enumeration, the endpoint returns 200 regardless of
 * whether the email exists or is already verified.
 */
authRoutes.post(
  "/resend-verification",
  registerRateLimiter,
  async (req: Request, res: Response) => {
    const { email } = req.body;

    if (!email || typeof email !== "string") {
      throw createError(ERROR_CODES.MISSING_FIELD, "Email is required", {
        error: "MISSING_EMAIL",
      });
    }

    try {
      const encryptedEmail = encrypt(email);
      const userResult = await queryRead(
        `SELECT id, email_verified
           FROM users
          WHERE email = $1
          LIMIT 1`,
        [encryptedEmail],
      );

      if (userResult.rows.length === 0 || userResult.rows[0].email_verified === true) {
        res.json({ message: "If the account exists and is unverified, a new verification email has been sent." });
        return;
      }

      const { id: userId } = userResult.rows[0] as { id: string };

      const { token: verificationToken } =
        await issueEmailVerificationToken(userId);

      const baseUrl =
        process.env.EMAIL_VERIFICATION_BASE_URL ||
        `${req.protocol}://${req.get("host")}`;
      const verificationLink = `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`;

      try {
        await emailService.sendEmailVerification(email, {
          verificationLink,
          expiresInHours: 24,
        });
      } catch (emailErr) {
        console.error("[Resend] Failed to send verification email:", emailErr);
      }

      res.json({ message: "If your account exists and is unverified, a new verification email has been sent." });
    } catch (error) {
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Unable to resend verification",
        {
          error: "RESEND_FAILED",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  },
);

/**
 * GET /api/auth/me
 *
 * Protected route that returns current user information
 * Requires valid JWT token in Authorization header
 */
authRoutes.get(
  "/me",
  authenticateToken,
  requireVerifiedEmail,
  async (req: Request, res: Response) => {
    const payload = req.jwtUser as JWTPayload;

    if (!payload) {
      throw createError(ERROR_CODES.MISSING_FIELD, "No token provided", {
        error: "Access denied",
      });
    }

    try {
      const permissions = await getUserPermissions(payload.userId);

      const cacheKey = `user:balance:stats:${payload.userId}`;
      let balanceStats = {
        total_deposited: "0",
        total_withdrawn: "0",
        current_balance: "0",
        available_balance: "0",
        pending_balance: "0",
      };

      if (redisClient.isOpen) {
        const cachedStats = await redisClient.get(cacheKey);
        if (cachedStats) {
          try {
            balanceStats = JSON.parse(cachedStats.toString());
          } catch (e) {
            console.error("Error parsing cached balance stats", e);
          }
        } else {
          const transactionModel = new TransactionModel();
          const dbStats = await transactionModel.getBalanceStatistics(
            payload.userId,
          );
          if (dbStats) {
            balanceStats = {
              total_deposited: dbStats.total_deposited || "0",
              total_withdrawn: dbStats.total_withdrawn || "0",
              current_balance: dbStats.current_balance || "0",
              available_balance: dbStats.available_balance || "0",
              pending_balance: dbStats.pending_balance || "0",
            };
            await redisClient.set(cacheKey, JSON.stringify(balanceStats), {
              EX: 3600,
            });
          }
        }
      } else {
        const transactionModel = new TransactionModel();
        const dbStats = await transactionModel.getBalanceStatistics(
          payload.userId,
        );
        if (dbStats) {
          balanceStats = {
            total_deposited: dbStats.total_deposited || "0",
            total_withdrawn: dbStats.total_withdrawn || "0",
            current_balance: dbStats.current_balance || "0",
            available_balance: dbStats.available_balance || "0",
            pending_balance: dbStats.pending_balance || "0",
          };
        }
      }

      res.json({
        user: {
          userId: payload.userId,
          email: payload.email,
          role: payload.role,
          permissions,
          total_deposited: balanceStats.total_deposited,
          total_withdrawn: balanceStats.total_withdrawn,
          current_balance: balanceStats.current_balance,
          available_balance: balanceStats.available_balance,
          pending_balance: balanceStats.pending_balance,
        },
        tokenInfo: {
          issuedAt: payload.iat,
          expiresAt: payload.exp,
        },
      });
    } catch (error) {
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Unable to fetch user info",
        {
          error: "Unable to fetch user info",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  },
);
