/**
 * Standard rate-limit response headers (#648).
 *
 * Every limiter in this service historically advertised its window with the
 * legacy `X-RateLimit-*` family, which is not the format clients, SDKs and
 * proxies can parse automatically. The IETF draft standard
 * (`draft-ietf-httpapi-ratelimit-headers`) defines a `RateLimit` field with
 * `limit` / `remaining` / `reset` parameters, also published as the individual
 * `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers for
 * clients that do not support structured fields.
 *
 * This module is the single place those headers are written, so every limiter
 * emits an identical, machine-readable shape. The legacy `X-RateLimit-*`
 * headers remain in place for backwards compatibility — the standard headers
 * are additive, not a replacement.
 */

import type { Response } from "express";

/** Header names from the IETF RateLimit header fields draft. */
export const RATE_LIMIT_HEADERS = {
  limit: "RateLimit-Limit",
  remaining: "RateLimit-Remaining",
  reset: "RateLimit-Reset",
} as const;

export interface StandardRateLimit {
  /** Maximum number of requests allowed in the current window. */
  limit: number;
  /** Requests still available in the current window (never negative). */
  remaining: number;
  /**
   * When the window resets, as a Unix timestamp in **seconds**. The draft also
   * allows a delta-seconds value; this service uses the absolute form so a
   * client that retries late still computes the correct delay.
   */
  resetEpochSeconds: number;
}

/** Normalises a reset instant to whole Unix seconds, rounding up. */
export function toResetEpochSeconds(reset: Date | number): number {
  const ms = reset instanceof Date ? reset.getTime() : reset;
  if (!Number.isFinite(ms)) {
    throw new Error(
      "Rate limit reset must be a finite Date or epoch milliseconds",
    );
  }
  return Math.ceil(ms / 1000);
}

/**
 * Writes the standard `RateLimit-*` headers onto a response.
 *
 * @param res       Express response to decorate.
 * @param rateLimit Limit, remaining quota and window reset instant.
 */
export function setStandardRateLimitHeaders(
  res: Response,
  { limit, remaining, resetEpochSeconds }: StandardRateLimit,
): void {
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error("Rate limit must be a non-negative finite number");
  }
  if (!Number.isFinite(remaining) || remaining < 0) {
    throw new Error("Rate limit remaining must be a non-negative finite number");
  }

  res.setHeader(RATE_LIMIT_HEADERS.limit, String(Math.floor(limit)));
  res.setHeader(
    RATE_LIMIT_HEADERS.remaining,
    String(Math.floor(remaining)),
  );
  res.setHeader(
    RATE_LIMIT_HEADERS.reset,
    String(Math.floor(resetEpochSeconds)),
  );
}
