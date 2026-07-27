import { redisClient } from "../../src/config/redis";

jest.mock("../../src/config/redis", () => ({
  redisClient: {
    isOpen: true,
    exists: jest.fn(),
    get: jest.fn(),
    setEx: jest.fn(),
  },
}));

const mockRedisClient = redisClient as unknown as {
  isOpen: boolean;
  exists: jest.Mock;
  get: jest.Mock;
  setEx: jest.Mock;
};

import {
  buildRequestFingerprint,
  isDeduplicationBypassed,
  isAdminRequest,
  requestDeduplication,
  storeFingerprint,
  getCachedResponse,
  cacheResponse,
  DeduplicationError,
} from "../../src/middleware/requestDeduplication";

function makeReq(overrides: Record<string, unknown> = {}): any {
  return {
    method: "POST",
    originalUrl: "/api/transactions?amount=1000",
    url: "/api/transactions?amount=1000",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: { phoneNumber: "+237600000000", amount: 1000 },
    user: { id: "user-1", role: "user" },
    route: { path: "/api/transactions" },
    on: jest.fn(),
    ...overrides,
  } as any;
}

function makeRes() {
  const statusCode = { value: 0 };
  const json = jest.fn().mockReturnValue({} as any);
  const status = jest.fn().mockImplementation((code: number) => {
    statusCode.value = code;
    return { json, end: jest.fn() } as any;
  });
  const on = jest.fn();

  const res = {
    status,
    json,
    end: jest.fn(),
    setHeader: jest.fn(),
    on,
  } as any;

  Object.defineProperty(res, "statusCode", {
    get: () => statusCode.value,
    set: (v: number) => { statusCode.value = v; },
    configurable: true,
    enumerable: true,
  });

  return res;
}

describe("requestDeduplication", () => {
  beforeEach(() => {
    mockRedisClient.isOpen = true;
    mockRedisClient.exists.mockReset();
    mockRedisClient.get.mockReset();
    mockRedisClient.setEx.mockReset();
  });

  describe("buildRequestFingerprint", () => {
    it("returns a stable sha256 hash", () => {
      const req = makeReq();
      const fp1 = buildRequestFingerprint(req);
      const fp2 = buildRequestFingerprint(req);
      expect(fp1).toBe(fp2);
      expect(fp1).toHaveLength(64);
      expect(/^[a-f0-9]+$/.test(fp1)).toBe(true);
    });

    it("changes when body changes", () => {
      const reqA = makeReq({ body: { phoneNumber: "+237600000000", amount: 1000 } });
      const reqB = makeReq({ body: { phoneNumber: "+237600000000", amount: 2000 } });
      expect(buildRequestFingerprint(reqA)).not.toBe(buildRequestFingerprint(reqB));
    });

    it("changes when query params change", () => {
      const reqA = makeReq({ originalUrl: "/api/transactions?amount=1000" });
      const reqB = makeReq({ originalUrl: "/api/transactions?amount=2000" });
      expect(buildRequestFingerprint(reqA)).not.toBe(buildRequestFingerprint(reqB));
    });

    it("changes when method changes", () => {
      const reqA = makeReq({ method: "POST" });
      const reqB = makeReq({ method: "GET" });
      expect(buildRequestFingerprint(reqA)).not.toBe(buildRequestFingerprint(reqB));
    });

    it("ignores query param ordering", () => {
      const reqA = makeReq({ originalUrl: "/api/transactions?amount=1000&currency=XAF" });
      const reqB = makeReq({ originalUrl: "/api/transactions?currency=XAF&amount=1000" });
      expect(buildRequestFingerprint(reqA)).toBe(buildRequestFingerprint(reqB));
    });
  });

  describe("bypass helpers", () => {
    it("detects admin role", () => {
      expect(isAdminRequest(makeReq({ user: { role: "admin" } }))).toBe(true);
      expect(isAdminRequest(makeReq({ user: { role: "super-admin" } }))).toBe(true);
      expect(isAdminRequest(makeReq({ user: { role: "user" } }))).toBe(false);
      expect(isAdminRequest(makeReq())).toBe(false);
    });
  });

  describe("middleware", () => {
    it("passes through when redis is unavailable", async () => {
      mockRedisClient.isOpen = false;
      const middleware = requestDeduplication();
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();

      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it("blocks duplicate request when redis detects existing fingerprint", async () => {
      mockRedisClient.exists.mockResolvedValue(1);

      const middleware = requestDeduplication();
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(DeduplicationError));
      expect(mockRedisClient.exists).toHaveBeenCalledWith(
        expect.stringContaining("dedup:fp:"),
      );
    });

    it("stores fingerprint on successful first request", async () => {
      mockRedisClient.exists.mockResolvedValue(0);

      const middleware = requestDeduplication();
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();

      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();

      res.status(200).json({ ok: true });
      const finishEvent = res.on.mock.calls.find(([event]) => event === "finish");
      expect(finishEvent).toBeDefined();
      (finishEvent![1] as Function)();

      expect(mockRedisClient.setEx).toHaveBeenCalled();
    });

    it("skips deduplication for admin requests", async () => {
      mockRedisClient.exists.mockResolvedValue(1);
      const middleware = requestDeduplication();
      const req = makeReq({ user: { role: "admin" } });
      const res = makeRes();
      const next = jest.fn();

      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it("skips deduplication when bypass header is set", async () => {
      mockRedisClient.exists.mockResolvedValue(1);
      const middleware = requestDeduplication();
      const req = makeReq({ headers: { "x-deduplication-bypass": "true" } });
      const res = makeRes();
      const next = jest.fn();

      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(mockRedisClient.exists).not.toHaveBeenCalled();
    });

    it("returns cached response for duplicate", async () => {
      mockRedisClient.exists.mockResolvedValue(1);
      mockRedisClient.get.mockResolvedValue(JSON.stringify({ status: 200, body: { ok: true } }));

      const middleware = requestDeduplication();
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(mockRedisClient.get).toHaveBeenCalledWith(
        expect.stringContaining("dedup:resp:"),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("storeFingerprint / getCachedResponse / cacheResponse", () => {
    it("stores fingerprint in redis", async () => {
      await storeFingerprint("abc123", 60);
      expect(mockRedisClient.setEx).toHaveBeenCalledWith("dedup:fp:abc123", 60, "1");
    });

    it("caches response body under a separate key", async () => {
      await cacheResponse("abc123", 200, { ok: true }, 60);
      expect(mockRedisClient.setEx).toHaveBeenCalledWith(
        "dedup:resp:abc123",
        60,
        JSON.stringify({ status: 200, body: { ok: true } }),
      );
    });

    it("returns cached response when available", async () => {
      mockRedisClient.get.mockResolvedValue(JSON.stringify({ status: 200, body: { ok: true } }));
      const result = await getCachedResponse("abc123");
      expect(result.hit).toBe(true);
      if (result.hit) {
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ ok: true });
      }
    });

    it("returns miss when no cached response", async () => {
      mockRedisClient.get.mockResolvedValue(null);
      const result = await getCachedResponse("abc123");
      expect(result.hit).toBe(false);
    });
  });
});
