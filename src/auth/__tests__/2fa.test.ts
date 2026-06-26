/**
 * TOTP 2FA tests — four acceptance criteria:
 *  1. POST /2fa/setup  → otpauth:// URI + backup codes
 *  2. POST /2fa/verify-setup → validates first TOTP token
 *  3. Login with 2FA enabled → { token, requires2fa: true }
 *  4. POST /2fa/verify → TOTP or backup code → full JWT
 */

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));
jest.mock("../../config/redis", () => ({
  redisClient: { isOpen: false, get: jest.fn(), set: jest.fn() },
  flushUserSessions: jest.fn(),
}));
jest.mock("../../config/env", () => ({ ADMIN_API_KEY: "test-admin-key" }));
jest.mock("../../auth/geo", () => ({
  evaluateGeoLoginAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));
jest.mock("../../auth/lockout");
jest.mock("../../services/loginAnomaly", () => ({
  evaluateAdminLoginAnomaly: jest.fn().mockResolvedValue({ suspicious: false }),
}));
jest.mock("../../models/refreshTokenFamily", () => ({
  RefreshTokenFamilyModel: jest.fn().mockImplementation(() => ({
    create: jest.fn().mockResolvedValue({}),
    findByToken: jest.fn().mockResolvedValue({ is_revoked: false }),
    revokeFamily: jest.fn().mockResolvedValue({}),
  })),
}));
jest.mock("../../services/twoFactorService");
jest.mock("../../services/userService");

import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import speakeasy from "speakeasy";

import { generateToken, generateTempToken, verifyTempToken } from "../jwt";
import { setupTOTP, verifyTOTPSetup, verifyTOTPLogin } from "../../services/twoFactorService";
import { authenticateUser, getUserById, getUserPermissions } from "../../services/userService";
import { getLockoutStatus } from "../../auth/lockout";
import { authRoutes } from "../../routes/auth";
import { errorHandler } from "../../middleware/errorHandler";
import { validateTOTPSetup, generateTOTPSecret } from "../2fa";

const mockSetupTOTP = setupTOTP as jest.MockedFunction<typeof setupTOTP>;
const mockVerifyTOTPSetup = verifyTOTPSetup as jest.MockedFunction<typeof verifyTOTPSetup>;
const mockVerifyTOTPLogin = verifyTOTPLogin as jest.MockedFunction<typeof verifyTOTPLogin>;
const mockAuthenticateUser = authenticateUser as jest.MockedFunction<typeof authenticateUser>;
const mockGetUserById = getUserById as jest.MockedFunction<typeof getUserById>;
const mockGetUserPermissions = getUserPermissions as jest.MockedFunction<typeof getUserPermissions>;
const mockGetLockoutStatus = getLockoutStatus as jest.MockedFunction<typeof getLockoutStatus>;

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use(errorHandler as unknown as (err: any, req: Request, res: Response, next: NextFunction) => void);

const UNLOCKED: any = { isLocked: false, minutesRemaining: 0, attemptsRemaining: 5, unlocksAt: null };
const BASE_USER: any = {
  id: "u1", phone_number: "+237600000001", kyc_level: "basic", role_name: "user",
  two_factor_secret: null, two_factor_enabled: false, two_factor_verified: false,
  backup_codes: null, created_at: new Date(), updated_at: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLockoutStatus.mockResolvedValue(UNLOCKED);
  mockGetUserById.mockResolvedValue(BASE_USER);
  mockGetUserPermissions.mockResolvedValue([]);
});

// ── JWT helpers ───────────────────────────────────────────────────────────────

describe("generateTempToken / verifyTempToken", () => {
  it("round-trips userId with purpose=2fa", () => {
    const token = generateTempToken("u1");
    const { userId, purpose } = verifyTempToken(token);
    expect(userId).toBe("u1");
    expect(purpose).toBe("2fa");
  });

  it("rejects a full JWT (wrong purpose)", () => {
    const full = generateToken({ userId: "u1", email: "a@b.com" });
    expect(() => verifyTempToken(full)).toThrow("Invalid token purpose");
  });
});

// ── Criterion 1: POST /2fa/setup ──────────────────────────────────────────────

describe("POST /api/auth/2fa/setup", () => {
  it("returns otpauthUri and backupCodes", async () => {
    mockSetupTOTP.mockResolvedValue({
      otpauthUri: "otpauth://totp/Mobile%20Money:test?secret=ABC",
      backupCodes: ["AABB1122", "CCDD3344"],
    });
    const token = generateToken({ userId: "u1", email: "t@t.com", role: "user" });
    const res = await request(app)
      .post("/api/auth/2fa/setup")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.otpauthUri).toMatch(/^otpauth:\/\//);
    expect(Array.isArray(res.body.backupCodes)).toBe(true);
    expect(mockSetupTOTP).toHaveBeenCalledWith("u1");
  });

  it("rejects unauthenticated request with 401", async () => {
    expect((await request(app).post("/api/auth/2fa/setup")).status).toBe(401);
  });
});

// ── Criterion 2: POST /2fa/verify-setup ──────────────────────────────────────

describe("POST /api/auth/2fa/verify-setup", () => {
  const jwt = () => generateToken({ userId: "u1", email: "t@t.com", role: "user" });

  it("returns 200 on valid TOTP code", async () => {
    mockVerifyTOTPSetup.mockResolvedValue(undefined);
    const res = await request(app)
      .post("/api/auth/2fa/verify-setup")
      .set("Authorization", `Bearer ${jwt()}`)
      .send({ token: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/enabled/i);
    expect(mockVerifyTOTPSetup).toHaveBeenCalledWith("u1", "123456");
  });

  it("returns 401 on invalid TOTP code", async () => {
    mockVerifyTOTPSetup.mockRejectedValue(new Error("Invalid TOTP token"));
    const res = await request(app)
      .post("/api/auth/2fa/verify-setup")
      .set("Authorization", `Bearer ${jwt()}`)
      .send({ token: "000000" });

    expect(res.status).toBe(401);
  });

  it("returns 400 when token field is missing", async () => {
    const res = await request(app)
      .post("/api/auth/2fa/verify-setup")
      .set("Authorization", `Bearer ${jwt()}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ── Criterion 3: Login gating ─────────────────────────────────────────────────

describe("POST /api/auth/login — 2FA gate", () => {
  it("returns { requires2fa: true } and a verifiable temp token when 2FA is enabled", async () => {
    mockAuthenticateUser.mockResolvedValue({
      ...BASE_USER,
      two_factor_secret: "JBSWY3DPEHPK3PXP",
      two_factor_enabled: true,
      two_factor_verified: true,
    });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ phone_number: "+237600000001" });

    expect(res.status).toBe(200);
    expect(res.body.requires2fa).toBe(true);
    expect(verifyTempToken(res.body.token).purpose).toBe("2fa");
  });

  it("returns full JWT (no requires2fa) when 2FA is not enabled", async () => {
    mockAuthenticateUser.mockResolvedValue(BASE_USER);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ phone_number: "+237600000001" });

    expect(res.status).toBe(200);
    expect(res.body.requires2fa).toBeUndefined();
    expect(res.body.token).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });
});

// ── Criterion 4: POST /2fa/verify ─────────────────────────────────────────────

describe("POST /api/auth/2fa/verify", () => {
  it("returns full JWT for valid TOTP code", async () => {
    mockVerifyTOTPLogin.mockResolvedValue({ userId: "u1", usedBackupCode: false });
    mockGetUserPermissions.mockResolvedValue(["transactions:read"]);
    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ tempToken: generateTempToken("u1"), code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user.userId).toBe("u1");
    expect(res.body.user.permissions).toContain("transactions:read");
  });

  it("returns full JWT when a backup code is accepted", async () => {
    mockVerifyTOTPLogin.mockResolvedValue({ userId: "u1", usedBackupCode: true, backupCodeId: "0" });
    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ tempToken: generateTempToken("u1"), code: "AABB1122" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it("returns 401 for wrong code", async () => {
    mockVerifyTOTPLogin.mockRejectedValue(new Error("Invalid 2FA code"));
    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ tempToken: generateTempToken("u1"), code: "000000" });

    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid temp token", async () => {
    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ tempToken: "bad.token.here", code: "123456" });

    expect(res.status).toBe(401);
  });

  it("returns 400 when code is missing", async () => {
    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ tempToken: generateTempToken("u1") });

    expect(res.status).toBe(400);
  });
});

// ── 2fa.ts unit tests (pure functions, no DB) ─────────────────────────────────

describe("2fa helpers (unit)", () => {
  it("generateTOTPSecret returns otpauth URI and 10 backup codes", () => {
    const { secret, qrCode, backupCodes } = generateTOTPSecret("test@example.com");
    expect(secret).toBeTruthy();
    expect(qrCode).toMatch(/^otpauth:\/\/totp\//);
    expect(backupCodes).toHaveLength(10);
  });

  it("validateTOTPSetup accepts a freshly generated token", () => {
    const { secret } = generateTOTPSecret("test@example.com");
    const token = speakeasy.totp({ secret, encoding: "base32" });
    expect(validateTOTPSetup(secret, token)).toBe(true);
  });

  it("validateTOTPSetup rejects a wrong token", () => {
    const { secret } = generateTOTPSecret("test@example.com");
    expect(validateTOTPSetup(secret, "000000")).toBe(false);
  });
});
