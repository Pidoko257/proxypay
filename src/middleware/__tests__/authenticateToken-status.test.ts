import express, { Request, Response } from "express";
import request from "supertest";
import { authenticateToken } from "../auth";
import { verifyToken } from "../../auth/jwt";
import { UserModel } from "../../models/users";

// ── Mock external dependencies ────────────────────────────────────────────────

jest.mock("../../auth/jwt");
jest.mock("../../auth/geo");
jest.mock("../../models/users");
jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;
const { evaluateGeoLoginAccess } = require("../../auth/geo");
import logger from "../../utils/logger";

// ── Test app factory ──────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(authenticateToken);
  app.get("/protected", (_req: Request, res: Response) =>
    res.json({ ok: true, userId: _req.jwtUser?.userId })
  );
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("authenticateToken with status enforcement", () => {
  let mockFindById: jest.MockedFunction<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    evaluateGeoLoginAccess.mockResolvedValue({ allowed: true });
    
    // Get the mocked prototype method
    mockFindById = (UserModel.prototype.findById as jest.MockedFunction<any>);
  });

  describe("with no token provided", () => {
    it("should return 401 access denied", async () => {
      const app = makeApp();
      const res = await request(app).get("/protected");

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "Access denied",
        message: "No token provided",
      });
    });
  });

  describe("with invalid token", () => {
    it("should return 401 invalid token", async () => {
      mockVerifyToken.mockImplementation(() => {
        throw new Error("Invalid token");
      });

      const app = makeApp();
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer invalid-token");

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "Invalid token",
        message: "Token is malformed or tampered with",
      });
    });
  });

  describe("with expired token", () => {
    it("should return 401 token expired", async () => {
      mockVerifyToken.mockImplementation(() => {
        throw new Error("Token has expired");
      });

      const app = makeApp();
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer expired-token");

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "Token expired",
        message: "Please log in again",
      });
    });
  });

  describe("with geo access denied", () => {
    it("should return 403 access denied from region", async () => {
      mockVerifyToken.mockReturnValue({
        userId: "user-123",
        role: "user",
        email: "user@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      evaluateGeoLoginAccess.mockResolvedValue({
        allowed: false,
        reason: "Access from this region is not permitted",
      });

      const app = makeApp();
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer valid-token");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Access denied",
        message: "Access from this region is not permitted",
      });
    });
  });

  describe("with valid token and active account", () => {
    it("should allow request to proceed", async () => {
      mockVerifyToken.mockReturnValue({
        userId: "user-123",
        role: "user",
        email: "user@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockFindById.mockResolvedValue({
        id: "user-123",
        phoneNumber: "+237123456789",
        kycLevel: "basic",
        email: "user@example.com",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const app = makeApp();
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer valid-token");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, userId: "user-123" });
    });
  });

  describe("with valid token but suspended account", () => {
    it("should block request after token verification", async () => {
      mockVerifyToken.mockReturnValue({
        userId: "user-123",
        role: "user",
        email: "user@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockFindById.mockResolvedValue({
        id: "user-123",
        phoneNumber: "+237123456789",
        kycLevel: "basic",
        email: "user@example.com",
        status: "suspended",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const app = makeApp();
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer valid-token")
        .set("User-Agent", "Mozilla/5.0");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Account suspended",
        message: "Your account has been suspended. Please contact support.",
        status: "suspended",
      });

      // Verify error was logged
      const mockLogger = logger as any;
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "SUSPICIOUS_ACTIVITY_FROM_RESTRICTED_ACCOUNT",
          userId: "user-123",
          accountStatus: "suspended",
          method: "GET",
        }),
        expect.any(String)
      );
    });
  });

  describe("with valid token but frozen account", () => {
    it("should block request with frozen account message", async () => {
      mockVerifyToken.mockReturnValue({
        userId: "user-456",
        role: "user",
        email: "user@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockFindById.mockResolvedValue({
        id: "user-456",
        phoneNumber: "+237987654321",
        kycLevel: "basic",
        email: "user@example.com",
        status: "frozen",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const app = makeApp();
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer valid-token");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Account frozen",
        message: "Your account has been frozen. Please contact support.",
        status: "frozen",
      });
    });
  });

  describe("when account status lookup fails", () => {
    it("should allow request to proceed (best-effort)", async () => {
      mockVerifyToken.mockReturnValue({
        userId: "user-123",
        role: "user",
        email: "user@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockFindById.mockRejectedValue(
        new Error("Database connection failed")
      );

      const app = makeApp();
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer valid-token");

      // Request should proceed despite lookup failure
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, userId: "user-123" });

      // Verify error was logged
      const mockLogger = logger as any;
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Database connection failed",
          userId: "user-123",
        }),
        "Error checking account status"
      );
    });
  });

  describe("request metadata in logs", () => {
    it("should include request context in suspension logs", async () => {
      mockVerifyToken.mockReturnValue({
        userId: "user-123",
        role: "user",
        email: "user@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockFindById.mockResolvedValue({
        id: "user-123",
        phoneNumber: "+237123456789",
        kycLevel: "basic",
        email: "user@example.com",
        status: "suspended",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const app = makeApp();
      await request(app)
        .get("/protected")
        .set("Authorization", "Bearer valid-token")
        .set("User-Agent", "Mozilla/5.0 (Test)")
        .set("Referer", "https://example.com/login");

      const mockLogger = logger as any;
      const callArgs = mockLogger.error.mock.calls[0];
      const logData = callArgs[0];

      expect(logData).toMatchObject({
        event: "SUSPICIOUS_ACTIVITY_FROM_RESTRICTED_ACCOUNT",
        userId: "user-123",
        accountStatus: "suspended",
        method: "GET",
        path: "/protected",
        userAgent: expect.stringContaining("Mozilla"),
        referer: "https://example.com/login",
      });
      expect(logData.ipAddress).toBeDefined();
    });
  });
});
