/**
 * Tests for correlationId middleware — issue #260
 */

import { Request, Response, NextFunction } from "express";
import {
  correlationIdMiddleware,
  resolveCorrelationId,
  CORRELATION_ID_HEADER,
  CORRELATION_ID_RESPONSE_HEADER,
} from "../../../src/middleware/correlationId";

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

function makeRes(): Response & { _headers: Record<string, string> } {
  const res: Partial<Response> & { _headers: Record<string, string> } = {
    _headers: {},
    setHeader(name: string, value: string) {
      this._headers![name] = value;
      return this as unknown as Response;
    },
  };
  return res as Response & { _headers: Record<string, string> };
}

describe("resolveCorrelationId", () => {
  it("prefers x-correlation-id over all other headers", () => {
    const req = makeReq({
      "x-correlation-id": "corr-123",
      "x-trace-id": "trace-456",
      "x-request-id": "req-789",
    });
    expect(resolveCorrelationId(req)).toBe("corr-123");
  });

  it("falls back to x-trace-id when x-correlation-id is absent", () => {
    const req = makeReq({ "x-trace-id": "trace-456", "x-request-id": "req-789" });
    expect(resolveCorrelationId(req)).toBe("trace-456");
  });

  it("falls back to x-request-id when neither correlation nor trace id present", () => {
    const req = makeReq({ "x-request-id": "req-789" });
    expect(resolveCorrelationId(req)).toBe("req-789");
  });

  it("generates a UUID when no headers are present", () => {
    const req = makeReq({});
    const id = resolveCorrelationId(req);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("generates a unique ID per request (no duplicates)", () => {
    const ids = new Set(
      Array.from({ length: 100 }, () => resolveCorrelationId(makeReq({}))),
    );
    expect(ids.size).toBe(100);
  });
});

describe("correlationIdMiddleware", () => {
  it("sets req.correlationId from x-correlation-id header", () => {
    const req = makeReq({ "x-correlation-id": "corr-abc" });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    correlationIdMiddleware(req, res, next);

    expect((req as Request & { correlationId: string }).correlationId).toBe("corr-abc");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("echoes the correlation ID in the response header", () => {
    const req = makeReq({ "x-correlation-id": "echo-id" });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    correlationIdMiddleware(req, res, next);

    expect(res._headers[CORRELATION_ID_RESPONSE_HEADER]).toBe("echo-id");
  });

  it("attaches a child logger to req.log", () => {
    const req = makeReq({ "x-correlation-id": "log-id" });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    correlationIdMiddleware(req, res, next);

    const r = req as Request & { log: unknown };
    expect(r.log).toBeDefined();
    expect(typeof (r.log as { info?: unknown }).info).toBe("function");
  });

  it("does not generate duplicate IDs for the same incoming header", () => {
    const header = "stable-id-xyz";
    const ids: string[] = [];

    for (let i = 0; i < 10; i++) {
      const req = makeReq({ "x-correlation-id": header });
      const res = makeRes();
      correlationIdMiddleware(req, res, jest.fn());
      ids.push((req as Request & { correlationId: string }).correlationId);
    }

    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(header);
  });

  it("calls next() exactly once", () => {
    const req = makeReq({});
    const res = makeRes();
    const next: NextFunction = jest.fn();

    correlationIdMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
