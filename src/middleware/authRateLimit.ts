import rateLimit from "express-rate-limit";
import type { Request } from "express";
import { accountIdentifier, isAccountLocked } from "../auth/lockout";

/**
 * Combines the client IP with the submitted phone number so that:
 *  - users behind a shared NAT IP do not share a single bucket, and
 *  - an attacker credential-stuffing from many IPs still hits a per-account
 *    limit (the phone number is part of the key).
 */
function accountKeyGenerator(req: Request): string {
  const phone = accountIdentifier(req.body?.phone_number) ?? "";
  return `${req.ip}:${phone}`;
}

/**
 * Rejects requests targeting an account that is currently locked out by
 * `src/auth/lockout.ts`, regardless of the source IP.
 */
async function rejectLockedAccount(
  req: Request,
  res: { status: (code: number) => { json: (body: unknown) => void } },
  next: () => void,
): Promise<void> {
  try {
    if (await isAccountLocked(req.body?.phone_number)) {
      res.status(429).json({
        error:
          "Your account has been temporarily locked due to too many failed login attempts. Please try again later.",
      });
      return;
    }
  } catch {
    // Fail open on lockout lookup errors — the rate limiter still applies.
  }
  next();
}

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: accountKeyGenerator,
  message: {
    error: "Too many login attempts. Please try again later.",
  },
});

export const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: accountKeyGenerator,
  message: {
    error: "Too many registration attempts. Please try again later.",
  },
});

export const loginLockoutGuard = rejectLockedAccount;
