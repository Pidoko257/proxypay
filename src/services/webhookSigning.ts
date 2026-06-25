import { createHmac, timingSafeEqual } from "crypto";

const REPLAY_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Compute HMAC-SHA256(secret, "t={timestamp}.{rawBody}").
 * Returns the hex digest (no prefix).
 */
export function signPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret)
    .update(`t=${timestamp}.${rawBody}`)
    .digest("hex");
}

export interface VerifyOptions {
  /** Expected value of X-ProxyPay-Signature-256 header (hex digest, no prefix) */
  signature: string;
  /** Value of X-ProxyPay-Timestamp header (Unix seconds as string) */
  timestamp: string;
  rawBody: string;
  secret: string;
  /** Override current time for testing */
  now?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "invalid" };

/**
 * Verify an inbound webhook signature and enforce a 5-minute replay window.
 */
export function verifySignature(opts: VerifyOptions): VerifyResult {
  const ts = Number(opts.timestamp);
  const currentMs = opts.now ?? Date.now();

  if (!Number.isFinite(ts) || Math.abs(currentMs - ts * 1000) > REPLAY_TOLERANCE_MS) {
    return { ok: false, reason: "expired" };
  }

  const expected = signPayload(opts.secret, opts.timestamp, opts.rawBody);
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(opts.signature, "hex");

  if (
    expectedBuf.length !== actualBuf.length ||
    !timingSafeEqual(expectedBuf, actualBuf)
  ) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true };
}
