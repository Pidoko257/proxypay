import { Request, Response, NextFunction } from "express";

// Mock i18n dependencies
jest.mock("../locales/messages", () => ({
  getLocalizedMessage: jest.fn((_code: string, _locale: string) => "Error message"),
}));
jest.mock("../utils/i18n", () => ({
  resolveLocale: jest.fn((l: string) => l || "en"),
  resolveLocaleFromRequest: jest.fn(() => "en"),
}));
jest.mock("../utils/logger", () => ({
  default: { error: jest.fn() },
}));

import { errorHandler } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";
import {
  ValidationError,
  NotFoundError,
  AuthenticationError,
  AuthError,
  AuthorizationError,
  ConflictError,
  BusinessLogicError,
} from "../utils/errors";

function makeReq(): Partial<Request> {
  return { headers: { "accept-language": "en" } };
}

function makeRes() {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  return { res: { status: statusMock } as unknown as Response, statusMock, jsonMock };
}

describe("Custom Error Classes — issue #108", () => {
  describe("ValidationError", () => {
    it("maps to 400 with INVALID_INPUT code", () => {
      const { res, statusMock, jsonMock } = makeRes();
      const err = new ValidationError("bad input");
      errorHandler(err, makeReq() as Request, res, jest.fn());
      expect(statusMock).toHaveBeenCalledWith(400);
      const body = jsonMock.mock.calls[0][0];
      expect(body.code).toBe(ERROR_CODES.INVALID_INPUT);
    });

    it("accepts custom code and details", () => {
      const { res, statusMock, jsonMock } = makeRes();
      const err = new ValidationError("bad phone", ERROR_CODES.INVALID_PHONE_FORMAT, { field: "phone" });
      errorHandler(err, makeReq() as Request, res, jest.fn());
      expect(statusMock).toHaveBeenCalledWith(400);
      const body = jsonMock.mock.calls[0][0];
      expect(body.code).toBe(ERROR_CODES.INVALID_PHONE_FORMAT);
    });

    it("response body has code, message, timestamp fields", () => {
      const { res, jsonMock } = makeRes();
      const err = new ValidationError("test");
      errorHandler(err, makeReq() as Request, res, jest.fn());
      const body = jsonMock.mock.calls[0][0];
      expect(body).toHaveProperty("code");
      expect(body).toHaveProperty("message");
      expect(body).toHaveProperty("timestamp");
    });

    it("does not include stack in response body", () => {
      const { res, jsonMock } = makeRes();
      const err = new ValidationError("test");
      errorHandler(err, makeReq() as Request, res, jest.fn());
      const body = jsonMock.mock.calls[0][0];
      expect(body).not.toHaveProperty("stack");
    });
  });

  describe("NotFoundError", () => {
    it("maps to 404 with NOT_FOUND code", () => {
      const { res, statusMock, jsonMock } = makeRes();
      const err = new NotFoundError("user not found");
      errorHandler(err, makeReq() as Request, res, jest.fn());
      expect(statusMock).toHaveBeenCalledWith(404);
      const body = jsonMock.mock.calls[0][0];
      expect(body.code).toBe(ERROR_CODES.NOT_FOUND);
    });
  });

  describe("AuthenticationError / AuthError", () => {
    it("AuthenticationError maps to 401 with UNAUTHORIZED code", () => {
      const { res, statusMock, jsonMock } = makeRes();
      const err = new AuthenticationError("not logged in");
      errorHandler(err, makeReq() as Request, res, jest.fn());
      expect(statusMock).toHaveBeenCalledWith(401);
      const body = jsonMock.mock.calls[0][0];
      expect(body.code).toBe(ERROR_CODES.UNAUTHORIZED);
    });

    it("AuthError alias is identical to AuthenticationError", () => {
      const { res, statusMock, jsonMock } = makeRes();
      const err = new AuthError("not logged in");
      errorHandler(err, makeReq() as Request, res, jest.fn());
      expect(statusMock).toHaveBeenCalledWith(401);
      const body = jsonMock.mock.calls[0][0];
      expect(body.code).toBe(ERROR_CODES.UNAUTHORIZED);
    });
  });

  describe("AuthorizationError", () => {
    it("maps to 403 with FORBIDDEN code", () => {
      const { res, statusMock, jsonMock } = makeRes();
      const err = new AuthorizationError("access denied");
      errorHandler(err, makeReq() as Request, res, jest.fn());
      expect(statusMock).toHaveBeenCalledWith(403);
      const body = jsonMock.mock.calls[0][0];
      expect(body.code).toBe(ERROR_CODES.FORBIDDEN);
    });
  });

  describe("ConflictError", () => {
    it("maps to 409 with CONFLICT code", () => {
      const { res, statusMock, jsonMock } = makeRes();
      const err = new ConflictError("already exists");
      errorHandler(err, makeReq() as Request, res, jest.fn());
      expect(statusMock).toHaveBeenCalledWith(409);
      const body = jsonMock.mock.calls[0][0];
      expect(body.code).toBe(ERROR_CODES.CONFLICT);
    });
  });

  describe("BusinessLogicError", () => {
    it("maps LIMIT_EXCEEDED to 429", () => {
      const { res, statusMock, jsonMock } = makeRes();
      const err = new BusinessLogicError("limit hit", ERROR_CODES.LIMIT_EXCEEDED);
      errorHandler(err, makeReq() as Request, res, jest.fn());
      expect(statusMock).toHaveBeenCalledWith(429);
      const body = jsonMock.mock.calls[0][0];
      expect(body.code).toBe(ERROR_CODES.LIMIT_EXCEEDED);
    });

    it("maps PROVIDER_ERROR to 502", () => {
      const { res, statusMock, jsonMock } = makeRes();
      const err = new BusinessLogicError("upstream failed", ERROR_CODES.PROVIDER_ERROR);
      errorHandler(err, makeReq() as Request, res, jest.fn());
      expect(statusMock).toHaveBeenCalledWith(502);
      const body = jsonMock.mock.calls[0][0];
      expect(body.code).toBe(ERROR_CODES.PROVIDER_ERROR);
    });

    it("includes details when provided", () => {
      const { res, jsonMock } = makeRes();
      const details = { balance: 100, requested: 500 };
      const err = new BusinessLogicError("insufficient", ERROR_CODES.INSUFFICIENT_BALANCE, details);
      errorHandler(err, makeReq() as Request, res, jest.fn());
      const body = jsonMock.mock.calls[0][0];
      // details present in non-production
      expect(body.details).toBeDefined();
    });
  });

  describe("500 errors — production stack trace suppression", () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it("does not include stack in response in production", () => {
      process.env.NODE_ENV = "production";
      const { res, jsonMock } = makeRes();
      const err = new Error("boom");
      (err as any).code = ERROR_CODES.INTERNAL_ERROR;
      (err as any).statusCode = 500;
      errorHandler(err, makeReq() as Request, res, jest.fn());
      const body = jsonMock.mock.calls[0][0];
      expect(body).not.toHaveProperty("stack");
      // details stripped in production
      expect(body.details).toBeUndefined();
    });

    it("does not include stack in response in development either", () => {
      process.env.NODE_ENV = "development";
      const { res, jsonMock } = makeRes();
      const err = new Error("boom");
      (err as any).code = ERROR_CODES.INTERNAL_ERROR;
      (err as any).statusCode = 500;
      errorHandler(err, makeReq() as Request, res, jest.fn());
      const body = jsonMock.mock.calls[0][0];
      expect(body).not.toHaveProperty("stack");
    });
  });

  describe("SERVICE_UNAVAILABLE returns 503", () => {
    it("maps SERVICE_UNAVAILABLE to HTTP 503", () => {
      const { res, statusMock } = makeRes();
      const err = new Error("down");
      (err as any).code = ERROR_CODES.SERVICE_UNAVAILABLE;
      errorHandler(err, makeReq() as Request, res, jest.fn());
      expect(statusMock).toHaveBeenCalledWith(503);
    });
  });

  describe("requestId is included when present", () => {
    it("includes requestId from error object", () => {
      const { res, jsonMock } = makeRes();
      const err = new ValidationError("bad");
      (err as any).requestId = "req-abc-123";
      errorHandler(err, makeReq() as Request, res, jest.fn());
      const body = jsonMock.mock.calls[0][0];
      expect(body.requestId).toBe("req-abc-123");
    });

    it("includes requestId from req object", () => {
      const { res, jsonMock } = makeRes();
      const err = new ValidationError("bad");
      const req = { ...makeReq(), requestId: "req-xyz-456" } as any;
      errorHandler(err, req as Request, res, jest.fn());
      const body = jsonMock.mock.calls[0][0];
      expect(body.requestId).toBe("req-xyz-456");
    });
  });
});
