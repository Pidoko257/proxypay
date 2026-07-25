import express, { Request, Response } from "express";
import request from "supertest";
import { idempotencyMiddleware, extractIdempotencyKey } from "../../src/middleware/idempotency";
import * as redisModule from "../../src/config/redis";
import * as loggerModule from "../../src/utils/logger";

jest.mock("../../src/config/redis");
jest.mock("../../src/utils/logger");

describe("Idempotency Middleware", () => {
  const mockRedisClient = {
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  };

  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (redisModule.redisClient as any) = mockRedisClient;
    (loggerModule.logger as any) = mockLogger;
  });

  describe("extractIdempotencyKey", () => {
    it("extracts valid UUID idempotency key", () => {
      const req = {
        header: jest.fn().mockReturnValue("550e8400-e29b-41d4-a716-446655440000"),
      } as any;

      const key = extractIdempotencyKey(req);
      expect(key).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("returns null when no key provided", () => {
      const req = {
        header: jest.fn().mockReturnValue(undefined),
      } as any;

      const key = extractIdempotencyKey(req);
      expect(key).toBeNull();
    });

    it("throws error for invalid UUID format", () => {
      const req = {
        header: jest.fn().mockReturnValue("invalid-key"),
      } as any;

      expect(() => extractIdempotencyKey(req)).toThrow(
        /Invalid idempotency key format/,
      );
    });

    it("trims whitespace from key", () => {
      const req = {
        header: jest.fn().mockReturnValue("  550e8400-e29b-41d4-a716-446655440000  "),
      } as any;

      const key = extractIdempotencyKey(req);
      expect(key).toBe("550e8400-e29b-41d4-a716-446655440000");
    });
  });

  describe("idempotencyMiddleware", () => {
    function createApp() {
      const app = express();
      app.use(express.json());
      app.use(idempotencyMiddleware);
      app.post("/test", (_req: Request, res: Response) => {
        res.json({ result: "success" });
      });
      return app;
    }

    it("caches successful response on first request", async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.setex.mockResolvedValue("OK");

      const app = createApp();
      const idempotencyKey = "550e8400-e29b-41d4-a716-446655440000";

      const response = await request(app)
        .post("/test")
        .set("Idempotency-Key", idempotencyKey)
        .send({ test: "data" });

      expect(response.status).toBe(200);
      expect(mockRedisClient.setex).toHaveBeenCalled();
      expect(mockRedisClient.setex.mock.calls[0][0]).toContain(idempotencyKey);
    });

    it("returns cached response on duplicate request", async () => {
      const cachedResponse = {
        statusCode: 200,
        headers: { "x-idempotency-cached": "true" },
        body: { result: "cached" },
        timestamp: Date.now(),
      };

      mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedResponse));

      const app = createApp();
      const idempotencyKey = "550e8400-e29b-41d4-a716-446655440000";

      const response = await request(app)
        .post("/test")
        .set("Idempotency-Key", idempotencyKey)
        .send({ test: "data" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ result: "cached" });
      expect(response.header("x-idempotency-cached")).toBe("true");
    });

    it("skips idempotency for GET requests", async () => {
      const app = createApp();
      app.get("/test", (_req: Request, res: Response) => {
        res.json({ result: "get" });
      });

      const idempotencyKey = "550e8400-e29b-41d4-a716-446655440000";

      const response = await request(app)
        .get("/test")
        .set("Idempotency-Key", idempotencyKey);

      expect(response.status).toBe(200);
      expect(mockRedisClient.setex).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid idempotency key", async () => {
      const app = createApp();

      const response = await request(app)
        .post("/test")
        .set("Idempotency-Key", "invalid")
        .send({ test: "data" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_IDEMPOTENCY_KEY");
    });

    it("only caches 2xx responses", async () => {
      const app = express();
      app.use(express.json());
      app.use(idempotencyMiddleware);
      app.post("/error", (_req: Request, res: Response) => {
        res.status(400).json({ error: "bad request" });
      });

      mockRedisClient.get.mockResolvedValue(null);

      const response = await request(app)
        .post("/error")
        .set("Idempotency-Key", "550e8400-e29b-41d4-a716-446655440000");

      expect(response.status).toBe(400);
      expect(mockRedisClient.setex).not.toHaveBeenCalled();
    });

    it("attaches user ID to cache key", async () => {
      const app = express();
      app.use(express.json());
      app.use((req: Request, _res: Response, next) => {
        (req as any).user = { id: "user-123" };
        next();
      });
      app.use(idempotencyMiddleware);
      app.post("/test", (_req: Request, res: Response) => {
        res.json({ result: "success" });
      });

      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.setex.mockResolvedValue("OK");

      const response = await request(app)
        .post("/test")
        .set("Idempotency-Key", "550e8400-e29b-41d4-a716-446655440000");

      expect(response.status).toBe(200);
      expect(mockRedisClient.setex).toHaveBeenCalled();
      expect(mockRedisClient.setex.mock.calls[0][0]).toContain("user-123");
    });
  });
});
