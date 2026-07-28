import request from "supertest";
import express from "express";
import { authRoutes } from "../auth";
import { errorHandler } from "../../middleware/errorHandler";

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    quit: jest.fn(),
  },
}));

jest.mock("../../services/email", () => ({
  EmailService: jest.fn().mockImplementation(() => ({
    sendEmailVerification: jest.fn(),
    sendAccountLockoutNotification: jest.fn(),
  })),
}));

jest.mock("../../utils/encryption", () => ({
  encrypt: jest.fn((value: string) => `enc:${value}`),
  decrypt: jest.fn(),
  encryptField: jest.fn(),
  decryptField: jest.fn(),
}));

jest.mock("../../middleware/auth", () => ({
  authenticateToken: jest.fn((req: any, _: any, next: any) => {
    req.jwtUser = { userId: "test-user-id", email: "test@example.com", role: "user" };
    next();
  }),
}));

jest.mock("../../middleware/authRateLimit", () => ({
  loginRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
  registerRateLimiter: jest.fn((_req: any, _res: any, next: any) => next()),
}));

jest.mock("../../services/userService", () => ({
  createUser: jest.fn(),
  authenticateUser: jest.fn(),
  getUserPermissions: jest.fn(),
  getUserByPhoneNumber: jest.fn(),
  User: class {},
}));

jest.mock("../../auth/jwt", () => ({
  generateToken: jest.fn(() => "mock-token"),
  verifyToken: jest.fn(),
  generateRefreshToken: jest.fn(),
  verifyRefreshToken: jest.fn(),
  JWTPayload: class {},
}));

jest.mock("../../utils/password", () => ({
  hashPassword: jest.fn(),
}));

jest.mock("../../auth/sso", () => ({
  createSSORouter: () => require("express").Router(),
}));

jest.mock("../../auth/oidc", () => ({
  initializeOIDCProviders: jest.fn(),
  createOIDCRouter: () => require("express").Router(),
}));

jest.mock("../../controllers/tokenController", () => ({
  tokenController: { findAll: jest.fn(), revokeAll: jest.fn(), revoke: jest.fn() },
}));

jest.mock("../../middleware/ssoEnforcement", () => ({
  enforceSSOForEmployees: jest.fn(),
}));

jest.mock("../../auth/lockout", () => ({
  getLockoutStatus: jest.fn(),
  recordFailedAttempt: jest.fn(),
}));

jest.mock("../../auth/2fa", () => ({
  verifyTOTPToken: jest.fn(),
  verifyBackupCode: jest.fn(),
  is2FAEnabled: jest.fn(),
}));

jest.mock("../../services/loginAnomaly", () => ({
  evaluateAdminLoginAnomaly: jest.fn(),
}));

jest.mock("../../models/transaction", () => ({
  TransactionModel: jest.fn(),
}));

jest.mock("../../auth/emailVerification", () => ({
  issueEmailVerificationToken: jest.fn(),
  consumeEmailVerificationToken: jest.fn(),
}));

describe("GET /api/auth/verify-email", () => {
  let app: express.Application;
  const { queryWrite } = require("../../config/database");
  const { consumeEmailVerificationToken } = require("../../auth/emailVerification");

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-key";
    process.env.NODE_ENV = "test";
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use("/api/auth", authRoutes);
    app.use(errorHandler);
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("should return 400 when no token is provided", async () => {
    const res = await request(app).get("/api/auth/verify-email");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_FIELD");
  });

  it("should return 401 for an invalid token", async () => {
    (consumeEmailVerificationToken as jest.Mock).mockImplementationOnce(() => {
      throw new Error("Invalid email verification token");
    });

    const res = await request(app).get("/api/auth/verify-email?token=invalid.jwt.token");

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_TOKEN");
  });

  it("should activate the account when a valid token is consumed", async () => {
    (consumeEmailVerificationToken as jest.Mock).mockResolvedValueOnce({
      userId: "user-42",
      tokenId: "tok-99",
    });
    (queryWrite as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(
      "/api/auth/verify-email?token=valid.token.value",
    );

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe("user-42");
    expect(queryWrite).toHaveBeenCalledWith(
      expect.stringContaining("SET email_verified = true"),
      ["user-42"],
    );
  });

  it("should return 401 when the token has been consumed (Redis miss)", async () => {
    (consumeEmailVerificationToken as jest.Mock).mockImplementationOnce(() => {
      throw new Error("Email verification token has been used or revoked");
    });

    const res = await request(app).get(
      "/api/auth/verify-email?token=consumed.token",
    );

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_TOKEN");
  });
});
