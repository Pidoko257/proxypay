import cors from "cors";
import express from "express";
import request from "supertest";

// corsOptions is built at module load time from ALLOWED_ORIGINS, so we must
// set the env var before the first import of express.ts.
process.env.ALLOWED_ORIGINS = "https://app.example.com,https://staging.example.com";
process.env.NODE_ENV = "test";

import { corsOptions } from "../../src/config/express";

function buildApp() {
  const app = express();
  app.options("*", cors(corsOptions));
  app.use(cors(corsOptions));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  return app;
}

describe("CORS — allowlist-based configuration", () => {
  it("allows a request from a listed origin", async () => {
    const res = await request(buildApp())
      .get("/health")
      .set("Origin", "https://app.example.com");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("blocks a request from an unlisted origin", async () => {
    const res = await request(buildApp())
      .get("/health")
      .set("Origin", "https://evil.com");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("handles preflight OPTIONS correctly for a listed origin", async () => {
    const res = await request(buildApp())
      .options("/health")
      .set("Origin", "https://staging.example.com")
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://staging.example.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(Number(res.headers["access-control-max-age"])).toBeGreaterThan(0);
  });

  it("rejects preflight OPTIONS from an unlisted origin", async () => {
    const res = await request(buildApp())
      .options("/health")
      .set("Origin", "https://attacker.com")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sets credentials: true only when origin is in the allowlist", async () => {
    const allowed = await request(buildApp())
      .get("/health")
      .set("Origin", "https://app.example.com");

    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

    const blocked = await request(buildApp())
      .get("/health")
      .set("Origin", "https://evil.com");

    expect(blocked.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});
