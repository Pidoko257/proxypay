/**
 * Unit tests for the shared pagination middleware (parsePaginationQuery /
 * parseRequestPagination): shared maximum page size, opaque cursor decoding
 * and 400 responses for malformed cursors.
 */

import express from "express";
import request from "supertest";
import { createCursor } from "../../utils/pagination";
import { parsePaginationQuery, parseRequestPagination } from "../pagination";

function errorHandler(
  err: any,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) {
  const status = err.statusCode ?? err.status ?? 500;
  res.status(status).json({ error: err.message, details: err.details });
}

function createApp(options = {}) {
  const app = express();
  app.get("/items", parsePaginationQuery(options), (req, res) => {
    res.json({ pagination: req.pagination });
  });
  app.get("/items-inline", (req, res) => {
    const parsed = parseRequestPagination(req, res, options);
    if (!parsed) {
      return;
    }
    res.json({ pagination: parsed });
  });
  app.use(errorHandler);
  return app;
}

describe("parsePaginationQuery middleware", () => {
  it("attaches default pagination params when the query is empty", async () => {
    const res = await request(createApp()).get("/items");

    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ limit: 20, offset: 0 });
    expect(res.body.pagination.after).toBeUndefined();
    expect(res.body.pagination.before).toBeUndefined();
  });

  it("clamps an oversized limit to the shared maximum page size", async () => {
    const res = await request(createApp()).get("/items?limit=100000");

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
  });

  it("clamps a custom maxLimit when provided", async () => {
    const res = await request(createApp({ maxLimit: 25 })).get(
      "/items?limit=200",
    );

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(25);
  });

  it("decodes a valid opaque cursor into after", async () => {
    const cursor = createCursor("2026-03-27T11:46:00.000Z", "txn-1");
    const res = await request(createApp()).get(
      `/items?after=${encodeURIComponent(cursor)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.pagination.after).toEqual({
      v: 1,
      t: "2026-03-27T11:46:00.000Z",
      id: "txn-1",
    });
  });

  it("returns 400 for a malformed cursor", async () => {
    const garbage = Buffer.from("garbage").toString("base64");
    const res = await request(createApp()).get(
      `/items?after=${encodeURIComponent(garbage)}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid cursor");
  });

  it("returns 400 when both before and after are supplied", async () => {
    const res = await request(createApp()).get("/items?before=a&after=b");

    expect(res.status).toBe(400);
  });
});

describe("parseRequestPagination helper", () => {
  it("writes a 400 and returns null for a malformed cursor", async () => {
    const res = await request(createApp()).get(
      "/items-inline?cursor=not!a!cursor",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid cursor");
  });

  it("returns validated params for valid input", async () => {
    const cursor = createCursor("2026-03-27T11:46:00.000Z", "txn-9");
    const res = await request(createApp()).get(
      `/items-inline?limit=500&cursor=${encodeURIComponent(cursor)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
    expect(res.body.pagination.after.id).toBe("txn-9");
  });
});
