/**
 * #648 – Standard `RateLimit-*` response headers
 *
 * The legacy `X-RateLimit-*` family is not machine-parseable by generic HTTP
 * clients. These tests pin the IETF draft standard shape
 * (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`) that every
 * limiter in the service now emits alongside the legacy headers.
 */
import {
  RATE_LIMIT_HEADERS,
  setStandardRateLimitHeaders,
  toResetEpochSeconds,
} from "../rateLimitHeaders";

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    setHeader: jest.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    headers,
  } as any;
}

describe("toResetEpochSeconds", () => {
  it("converts epoch milliseconds to whole Unix seconds", () => {
    expect(toResetEpochSeconds(1_700_000_000_000)).toBe(1_700_000_000);
  });

  it("accepts a Date", () => {
    expect(toResetEpochSeconds(new Date(1_700_000_000_000))).toBe(
      1_700_000_000,
    );
  });

  it("rounds partial seconds up so a client never retries too early", () => {
    expect(toResetEpochSeconds(1_700_000_000_500)).toBe(1_700_000_001);
  });

  it("rejects a non-finite reset instant", () => {
    expect(() => toResetEpochSeconds(Number.NaN)).toThrow(
      /finite Date or epoch milliseconds/,
    );
  });
});

describe("setStandardRateLimitHeaders", () => {
  it("writes the three standard headers with plain numeric values", () => {
    const res = makeRes();

    setStandardRateLimitHeaders(res, {
      limit: 60,
      remaining: 42,
      resetEpochSeconds: 1_700_000_000,
    });

    expect(res.setHeader).toHaveBeenCalledWith("RateLimit-Limit", "60");
    expect(res.setHeader).toHaveBeenCalledWith("RateLimit-Remaining", "42");
    expect(res.setHeader).toHaveBeenCalledWith(
      "RateLimit-Reset",
      "1700000000",
    );
  });

  it("does not prefix the header names with X-", () => {
    const res = makeRes();

    setStandardRateLimitHeaders(res, {
      limit: 5,
      remaining: 0,
      resetEpochSeconds: 1_700_000_000,
    });

    const names = res.setHeader.mock.calls.map(([name]) => name);
    expect(names).toEqual(Object.values(RATE_LIMIT_HEADERS));
    expect(names.every((n) => !n.startsWith("X-"))).toBe(true);
  });

  it("floors fractional limits and remaining values", () => {
    const res = makeRes();

    setStandardRateLimitHeaders(res, {
      limit: 9.99,
      remaining: 3.7,
      resetEpochSeconds: 1_700_000_000.9,
    });

    expect(res.headers["ratelimit-limit"]).toBe("9");
    expect(res.headers["ratelimit-remaining"]).toBe("3");
    expect(res.headers["ratelimit-reset"]).toBe("1700000000");
  });

  it("rejects a negative limit or remaining count", () => {
    const res = makeRes();

    expect(() =>
      setStandardRateLimitHeaders(res, {
        limit: -1,
        remaining: 0,
        resetEpochSeconds: 1,
      }),
    ).toThrow(/non-negative/);

    expect(() =>
      setStandardRateLimitHeaders(res, {
        limit: 1,
        remaining: -1,
        resetEpochSeconds: 1,
      }),
    ).toThrow(/non-negative/);
  });
});
