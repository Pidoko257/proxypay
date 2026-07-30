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

jest.mock("../../services/email", () => {
  const sendEmailVerification = jest.fn();
  const sendAccountLockoutNotification = jest.fn();
  return {
    EmailService: jest.fn().mockImplementation(() => ({
      sendEmailVerification,
      sendAccountLockoutNotification,
    })),
    __emailMocks: { sendEmailVerification, sendAccountLockoutNotification },
  };
});

jest.mock("../../utils/encryption", () => ({
  encrypt: jest.fn((value: string) => `enc:${value}`),
  decrypt: jest.fn((value: string) => value?.startsWith("enc:") ? value.slice(4) : value),
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
  hashPassword: jest.fn(async (pw: string) => `hashed:${pw}`),
}));

jest.mock("../../auth/sso", () => ({
  createSSORouter: () => {
    const r = require("express").Router();
    return r;
  },
}));

jest.mock("../../auth/oidc", () => ({
  initializeOIDCProviders: jest.fn(),
  createOIDCRouter: () => {
    const r = require("express").Router();
    return r;
  },
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
  issueEmailVerificationToken: jest.fn(async () => ({
    token: "test-verification-token",
    tokenId: "test-token-id",
    expiresInSeconds: 86400,
  })),
  consumeEmailVerificationToken: jest.fn(),
}));

describe("POST /api/auth/register (email verification)", () => {
  let app: express.Application;
  const { createUser } = require("../../services/userService");
  const { issueEmailVerificationToken } = require("../../auth/emailVerification");

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

  it("should reject registration without email", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ phone_number: "+237600000000", password: "ValidP@ssw0rd!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("should reject registration with invalid email", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        phone_number: "+237600000000",
        email: "not-an-email",
        password: "ValidP@ssw0rd!",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("should create user, issue verification token, and send email", async () => {
    (createUser as jest.Mock).mockResolvedValueOnce({
      id: "new-user-id",
      phone_number: "+237600111222",
    });

    const { __emailMocks } = require("../../services/email") as {
      __emailMocks: { sendEmailVerification: jest.Mock };
    };

    const res = await request(app)
      .post("/api/auth/register")
      .send({
        phone_number: "+237600111222",
        email: "user@example.com",
        password: "ValidP@ssw0rd!",
      });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe("new-user-id");
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        phone_number: "+237600111222",
        email: "user@example.com",
      }),
    );
    expect(issueEmailVerificationToken).toHaveBeenCalledWith("new-user-id");
    expect(__emailMocks.sendEmailVerification).toHaveBeenCalledWith(
      "user@example.com",
      expect.objectContaining({
        expiresInHours: 24,
        verificationLink: expect.stringContaining("/api/auth/verify-email?token="),
      }),
    );
  });
});
