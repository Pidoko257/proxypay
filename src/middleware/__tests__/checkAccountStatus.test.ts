import express, { Request, Response, NextFunction } from "express";
import request from "supertest";
import { checkAccountStatus, checkAccountStatusStrict } from "../checkAccountStatus";
import { UserModel } from "../../models/users";

// ── Mock external dependencies ────────────────────────────────────────────────

jest.mock("../../models/users");
jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

import logger from "../../utils/logger";

// ── Test app factories ────────────────────────────────────────────────────────

function makeAppWithStatus(middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Simulate authenticateToken setting jwtUser
    const userId = req.query.userId as string;
    if (userId) {
      req.jwtUser = { userId, role: "user", email: "" };
    }
    next();
  });
  app.use(middleware);
  app.get("/protected", (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkAccountStatus", () => {
  let mockUserModel: jest.Mocked<typeof UserModel>;
  let mockLogger: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserModel = UserModel as any;
    mockLogger = logger as any;
  });

  describe("with active account", () => {
    it("should allow request to proceed", async () => {
      mockUserModel.prototype.findById.mockResolvedValue({
        id: "user-123",
        phoneNumber: "+237123456789",
        kycLevel: "basic",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const app = makeAppWithStatus(checkAccountStatus);
      const res = await request(app).get("/protected?userId=user-123");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe("with suspended account", () => {
    it("should block request and log suspicious activity", async () => {
      mockUserModel.prototype.findById.mockResolvedValue({
        id: "user-123",
        phoneNumber: "+237123456789",
        kycLevel: "basic",
        status: "suspended",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const app = makeAppWithStatus(checkAccountStatus);
      const res = await request(app)
        .get("/protected?userId=user-123")
        .set("User-Agent", "Mozilla/5.0");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Account suspended",
        message: "Your account has been suspended. Please contact support.",
        status: "suspended",
      });

      // Verify suspicious activity was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "SUSPICIOUS_ACTIVITY_FROM_RESTRICTED_ACCOUNT",
          userId: "user-123",
          accountStatus: "suspended",
          method: "GET",
          path: "/protected?userId=user-123",
        }),
        "Blocked request from suspended account"
      );
    });
  });

  describe("with frozen account", () => {
    it("should block request and log suspicious activity", async () => {
      mockUserModel.prototype.findById.mockResolvedValue({
        id: "user-456",
        phoneNumber: "+237987654321",
        kycLevel: "basic",
        status: "frozen",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const app = makeAppWithStatus(checkAccountStatus);
      const res = await request(app)
        .get("/protected?userId=user-456")
        .set("User-Agent", "Mozilla/5.0");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Account frozen",
        message: "Your account has been frozen. Please contact support.",
        status: "frozen",
      });

      // Verify suspicious activity was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "SUSPICIOUS_ACTIVITY_FROM_RESTRICTED_ACCOUNT",
          userId: "user-456",
          accountStatus: "frozen",
          method: "GET",
        }),
        "Blocked request from frozen account"
      );
    });
  });

  describe("without JWT user", () => {
    it("should skip check and allow request to proceed", async () => {
      const app = makeAppWithStatus(checkAccountStatus);
      const res = await request(app).get("/protected");

      // Should proceed without calling findById
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockUserModel.prototype.findById).not.toHaveBeenCalled();
    });
  });

  describe("when user not found", () => {
    it("should return 401 and log warning", async () => {
      mockUserModel.prototype.findById.mockResolvedValue(null);

      const app = makeAppWithStatus(checkAccountStatus);
      const res = await request(app).get("/protected?userId=user-nonexistent");

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "User not found",
        message: "User account does not exist",
      });

      // Verify warning was logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-nonexistent",
        }),
        "User not found during status check"
      );
    });
  });

  describe("when database error occurs", () => {
    it("should log error but allow request to proceed (best-effort)", async () => {
      const dbError = new Error("Database connection failed");
      mockUserModel.prototype.findById.mockRejectedValue(dbError);

      const app = makeAppWithStatus(checkAccountStatus);
      const res = await request(app).get("/protected?userId=user-123");

      // Request should proceed despite error
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // Verify error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Database connection failed",
          userId: "user-123",
        }),
        "Error checking account status"
      );
    });
  });
});

describe("checkAccountStatusStrict", () => {
  let mockUserModel: jest.Mocked<typeof UserModel>;
  let mockLogger: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserModel = UserModel as any;
    mockLogger = logger as any;
  });

  describe("with active account", () => {
    it("should allow request to proceed", async () => {
      mockUserModel.prototype.findById.mockResolvedValue({
        id: "user-123",
        phoneNumber: "+237123456789",
        kycLevel: "basic",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const app = makeAppWithStatus(checkAccountStatusStrict);
      const res = await request(app).get("/protected?userId=user-123");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe("with suspended account", () => {
    it("should block request with specific transaction error message", async () => {
      mockUserModel.prototype.findById.mockResolvedValue({
        id: "user-123",
        phoneNumber: "+237123456789",
        kycLevel: "basic",
        status: "suspended",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const app = makeAppWithStatus(checkAccountStatusStrict);
      const res = await request(app).get("/protected?userId=user-123");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Account suspended",
        message: "Your account has been suspended. All deposits and withdrawals are blocked.",
        status: "suspended",
      });
    });
  });

  describe("with frozen account", () => {
    it("should block request with specific transaction error message", async () => {
      mockUserModel.prototype.findById.mockResolvedValue({
        id: "user-456",
        phoneNumber: "+237987654321",
        kycLevel: "basic",
        status: "frozen",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const app = makeAppWithStatus(checkAccountStatusStrict);
      const res = await request(app).get("/protected?userId=user-456");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Account frozen",
        message: "Your account has been frozen. All deposits and withdrawals are blocked.",
        status: "frozen",
      });
    });
  });

  describe("without JWT user", () => {
    it("should return 401 authentication error", async () => {
      const app = makeAppWithStatus(checkAccountStatusStrict);
      const res = await request(app).get("/protected");

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "Authentication required",
        message: "User must be authenticated to perform this action",
      });

      // Should not query database
      expect(mockUserModel.prototype.findById).not.toHaveBeenCalled();
    });
  });

  describe("when user not found", () => {
    it("should return 401 error", async () => {
      mockUserModel.prototype.findById.mockResolvedValue(null);

      const app = makeAppWithStatus(checkAccountStatusStrict);
      const res = await request(app).get("/protected?userId=user-nonexistent");

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "User not found",
        message: "User account does not exist",
      });

      // Verify error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-nonexistent",
        }),
        "User not found - cannot verify account status for transaction"
      );
    });
  });

  describe("when database error occurs", () => {
    it("should fail closed and return 500 error", async () => {
      const dbError = new Error("Database connection failed");
      mockUserModel.prototype.findById.mockRejectedValue(dbError);

      const app = makeAppWithStatus(checkAccountStatusStrict);
      const res = await request(app).get("/protected?userId=user-123");

      // Should NOT proceed - fail closed for transactions
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: "Internal server error",
        message: "Unable to verify account status",
      });

      // Verify error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Database connection failed",
          userId: "user-123",
        }),
        "Error checking account status for transaction - failing closed"
      );
    });
  });

  describe("logging includes security context", () => {
    it("should include IP address, user agent, and referer in logs", async () => {
      mockUserModel.prototype.findById.mockResolvedValue({
        id: "user-123",
        phoneNumber: "+237123456789",
        kycLevel: "basic",
        status: "suspended",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const app = makeAppWithStatus(checkAccountStatusStrict);
      const res = await request(app)
        .get("/protected?userId=user-123")
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0)")
        .set("Referer", "https://example.com");

      expect(res.status).toBe(403);

      // Verify security context was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "SUSPICIOUS_ACTIVITY_FROM_RESTRICTED_ACCOUNT",
          userId: "user-123",
          accountStatus: "suspended",
          method: "GET",
          userAgent: expect.stringContaining("Mozilla"),
          referer: "https://example.com",
        }),
        expect.any(String)
      );
    });
  });
});
