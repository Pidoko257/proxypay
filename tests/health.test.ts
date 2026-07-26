/**
 * Tests for GET /health dependency status (issue #22).
 * Exercises the health report builder with injectable checkers so we avoid
 * importing the full app / live infrastructure.
 */
import express, { Request, Response } from "express";
import request from "supertest";
import {
  DEPENDENCY_TIMEOUT_MS,
  runDependencyHealthChecks,
  type DependencyHealthDeps,
} from "../src/services/dependencyHealth";
import { HealthCheckResponse } from "../src/types/api";

function buildHealthApp(deps?: DependencyHealthDeps) {
  const app = express();
  app.get("/health", async (_req: Request, res: Response) => {
    const report = await runDependencyHealthChecks(deps);
    const body: HealthCheckResponse = {
      status: report.status,
      timestamp: report.timestamp,
      dependencies: report.dependencies,
      gitHash: report.gitHash,
    };
    res.status(report.status === "ok" ? 200 : 503).json(body);
  });
  return app;
}

const allUpDeps = (): DependencyHealthDeps => ({
  checkPostgres: async () => undefined,
  checkRedis: async () => undefined,
  checkBullmq: async () => undefined,
  checkHorizon: async () => undefined,
  checkMomo: async () => undefined,
});

describe("runDependencyHealthChecks", () => {
  it("returns up status and latency_ms for every dependency when all succeed", async () => {
    const report = await runDependencyHealthChecks(allUpDeps());

    expect(report.status).toBe("ok");
    expect(report.dependencies).toHaveLength(5);
    expect(report.dependencies.map((d) => d.name)).toEqual([
      "postgresql",
      "redis",
      "bullmq",
      "stellar_horizon",
      "momo",
    ]);
    for (const dep of report.dependencies) {
      expect(dep.status).toBe("up");
      expect(typeof dep.latency_ms).toBe("number");
      expect(dep.latency_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("marks a failed dependency as down and overall status as degraded", async () => {
    const report = await runDependencyHealthChecks({
      ...allUpDeps(),
      checkRedis: async () => {
        throw new Error("redis unavailable");
      },
    });

    expect(report.status).toBe("degraded");
    const redis = report.dependencies.find((d) => d.name === "redis");
    expect(redis?.status).toBe("down");
    expect(
      report.dependencies.filter((d) => d.name !== "redis").every((d) => d.status === "up"),
    ).toBe(true);
  });

  it("times out a slow dependency after DEPENDENCY_TIMEOUT_MS and marks it down", async () => {
    const timeoutMs = 50;
    const report = await runDependencyHealthChecks({
      ...allUpDeps(),
      timeoutMs,
      checkBullmq: async () => {
        await new Promise((resolve) => setTimeout(resolve, timeoutMs * 4));
      },
    });

    const bullmq = report.dependencies.find((d) => d.name === "bullmq");
    expect(bullmq?.status).toBe("down");
    expect(bullmq!.latency_ms).toBeGreaterThanOrEqual(timeoutMs);
    expect(bullmq!.latency_ms).toBeLessThan(timeoutMs * 4);
    expect(DEPENDENCY_TIMEOUT_MS).toBe(3_000);
  });

  it("includes gitHash when BUILD_HASH is set", async () => {
    process.env.BUILD_HASH = "abc123";
    const report = await runDependencyHealthChecks(allUpDeps());
    expect(report.gitHash).toBe("abc123");
    delete process.env.BUILD_HASH;
  });
});

describe("GET /health", () => {
  it("returns 200 with dependency statuses when all critical deps are up", async () => {
    const app = buildHealthApp(allUpDeps());
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.timestamp).toBe("string");
    expect(Array.isArray(res.body.dependencies)).toBe(true);
    expect(res.body.dependencies).toHaveLength(5);
    for (const dep of res.body.dependencies) {
      expect(dep).toEqual(
        expect.objectContaining({
          name: expect.any(String),
          status: "up",
          latency_ms: expect.any(Number),
        }),
      );
    }
  });

  it("returns 503 when any critical dependency is down", async () => {
    const app = buildHealthApp({
      ...allUpDeps(),
      checkHorizon: async () => {
        throw new Error("horizon down");
      },
    });
    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    const horizon = res.body.dependencies.find(
      (d: { name: string }) => d.name === "stellar_horizon",
    );
    expect(horizon.status).toBe("down");
  });

  it("includes gitHash when BUILD_HASH env var is set", async () => {
    process.env.BUILD_HASH = "test_hash_abc123";
    const app = buildHealthApp(allUpDeps());
    const res = await request(app).get("/health");
    expect(res.body.gitHash).toBe("test_hash_abc123");
    delete process.env.BUILD_HASH;
  });

  it("gitHash is undefined when BUILD_HASH is not set", async () => {
    delete process.env.BUILD_HASH;
    const app = buildHealthApp(allUpDeps());
    const res = await request(app).get("/health");
    expect(res.body.gitHash).toBeUndefined();
  });
});
