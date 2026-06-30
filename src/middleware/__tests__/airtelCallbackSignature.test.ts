import { NextFunction, Request, Response } from "express";

// Mock appConfig before importing the middleware
const mockGetConfigValue = jest.fn();
jest.mock("../../config/appConfig", () => ({
  getConfigValue: mockGetConfigValue,
}));

// Mock logger
const mockLogSecurityAnomaly = jest.fn();
jest.mock("../../services/logger", () => ({
  getCurrentRequestIp: jest.fn(() => "1.2.3.4"),
  logSecurityAnomaly: mockLogSecurityAnomaly,
}));

import { verifyAirtelCallbackSignature } from "../airtelCallbackSignature";

const SECRET = "test-airtel-secret-token";

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    body: {},
    method: "POST",
    originalUrl: "/api/airtel/callback",
    url: "/api/airtel/callback",
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetConfigValue.mockImplementation((key: string) => {
    if (key === "providers.airtel.callbackSecret") return SECRET;
    return undefined;
  });
});

describe("verifyAirtelCallbackSignature", () => {
  describe("secret not configured", () => {
    it("returns 500 and logs anomaly when secret is missing", async () => {
      mockGetConfigValue.mockImplementation((key: string) => {
        if (key === "providers.airtel.callbackSecret") return "";
        return undefined;
      });

      const req = makeReq();
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await verifyAirtelCallbackSignature(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Airtel callback verification not configured",
      });
      expect(next).not.toHaveBeenCalled();
      expect(mockLogSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "airtel_callback_secret_not_configured" }),
      );
    });
  });

  describe("missing Authorization header", () => {
    it("rejects with 403 when Authorization header is absent", async () => {
      const req = makeReq({ headers: {} });
      const next: NextFunction = jest.fn();

      await expect(
        verifyAirtelCallbackSignature(req, makeRes(), next),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(next).not.toHaveBeenCalled();
      expect(mockLogSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "airtel_callback_token_missing" }),
      );
    });

    it("rejects with 403 when Authorization header is not Bearer", async () => {
      const req = makeReq({ headers: { authorization: "Basic abc123" } });
      const next: NextFunction = jest.fn();

      await expect(
        verifyAirtelCallbackSignature(req, makeRes(), next),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("valid token", () => {
    it("calls next() for a valid bearer token", async () => {
      const req = makeReq({
        headers: { authorization: `Bearer ${SECRET}` },
      });
      const next: NextFunction = jest.fn();

      await verifyAirtelCallbackSignature(req, makeRes(), next);

      expect(next).toHaveBeenCalled();
      expect(mockLogSecurityAnomaly).not.toHaveBeenCalled();
    });
  });

  describe("invalid token", () => {
    it("rejects with 403 for a wrong bearer token", async () => {
      const req = makeReq({
        headers: { authorization: "Bearer wrong-token-value" },
      });
      const next: NextFunction = jest.fn();

      await expect(
        verifyAirtelCallbackSignature(req, makeRes(), next),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(next).not.toHaveBeenCalled();
      expect(mockLogSecurityAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "airtel_callback_token_invalid", headerPresent: true }),
      );
    });
  });
});
