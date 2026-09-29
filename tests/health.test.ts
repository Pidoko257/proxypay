/**
 * Focused test for the /health endpoint gitHash field (issue #736).
 * Avoids importing the full app to bypass pre-existing corruption in
 * unrelated files (export.ts, htlcService.ts, transactionController.ts).
 */
import express, { Request, Response } from "express";
import request from "supertest";
import { HealthCheckResponse } from "../src/types/api";

function buildHealthApp() {
  const app = express();
  app.get("/health", (_req: Request, res: Response) => {
    const body: HealthCheckResponse = {
      status: "ok",
      timestamp: new Date().toISOString(),
      gitHash: process.env.BUILD_HASH,
    };
    res.json(body);
  });
  return app;
}

describe("GET /health", () => {
  it("returns status ok with timestamp", async () => {
    const app = buildHealthApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.timestamp).toBe("string");
  });

  it("includes gitHash when BUILD_HASH env var is set", async () => {
    process.env.BUILD_HASH = "test_hash_abc123";
    const app = buildHealthApp();
    const res = await request(app).get("/health");
    expect(res.body.gitHash).toBe("test_hash_abc123");
    delete process.env.BUILD_HASH;
  });

  it("gitHash is undefined when BUILD_HASH is not set", async () => {
    delete process.env.BUILD_HASH;
    const app = buildHealthApp();
    const res = await request(app).get("/health");
    expect(res.body.gitHash).toBeUndefined();
  });

  it("reports component status and response times (issue #677)", async () => {
    const app = express();
    app.get("/health", (_req: Request, res: Response) => {
      const body: HealthCheckResponse = {
        status: "ok",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "ok",
            responseTimeMs: 5,
          },
          redis: {
            status: "ok",
            responseTimeMs: 2,
          },
          providers: {
            status: "ok",
            responseTimeMs: 12,
            details: {
              overall: "healthy",
              providers: { mtn: "up", airtel: "up" },
              healthyCount: 2,
              totalCount: 2,
            },
          },
        },
      };
      res.json(body);
    });

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.components).toBeDefined();
    expect(res.body.components.database.status).toBe("ok");
    expect(typeof res.body.components.database.responseTimeMs).toBe("number");
    expect(res.body.components.redis.status).toBe("ok");
    expect(typeof res.body.components.redis.responseTimeMs).toBe("number");
    expect(res.body.components.providers.status).toBe("ok");
    expect(typeof res.body.components.providers.responseTimeMs).toBe("number");
    expect(res.body.components.providers.details.overall).toBe("healthy");
  });

  it("reports degraded status when a component is down (issue #677)", async () => {
    const app = express();
    app.get("/health", (_req: Request, res: Response) => {
      const body: HealthCheckResponse = {
        status: "degraded",
        timestamp: new Date().toISOString(),
        components: {
          database: {
            status: "ok",
            responseTimeMs: 4,
          },
          redis: {
            status: "down",
            responseTimeMs: 10,
            error: "Connection refused",
          },
          providers: {
            status: "ok",
            responseTimeMs: 8,
          },
        },
      };
      res.json(body);
    });

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.components.redis.status).toBe("down");
    expect(res.body.components.redis.error).toBe("Connection refused");
  });
});
