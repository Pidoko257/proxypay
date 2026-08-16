/**
 * Unit tests for JWT Refresh Token Rotation Service — Issue #166
 */

// ─── Mock database ────────────────────────────────────────────────────────────

const mockQueryRead = jest.fn();
const mockQueryWrite = jest.fn();

jest.mock("../../config/database", () => ({
  queryRead: (...args: any[]) => mockQueryRead(...args),
  queryWrite: (...args: any[]) => mockQueryWrite(...args),
  pool: { query: jest.fn() },
}));

// ─── Mock jwt auth ────────────────────────────────────────────────────────────

const mockVerifyRefreshToken = jest.fn();
const mockGenerateToken = jest.fn();
const mockGenerateRefreshToken = jest.fn();

jest.mock("../../auth/jwt", () => ({
  verifyRefreshToken: (...args: any[]) => mockVerifyRefreshToken(...args),
  generateToken: (...args: any[]) => mockGenerateToken(...args),
  generateRefreshToken: (...args: any[]) => mockGenerateRefreshToken(...args),
}));

// ─── Mock userService ─────────────────────────────────────────────────────────

jest.mock("../../services/userService", () => ({
  getUserPermissions: jest.fn().mockResolvedValue([]),
}));

import {
  rotateRefreshToken,
  listActiveSessions,
  logoutSession,
  logoutAllSessions,
  recordInitialDeviceInfo,
} from "../refreshTokenService";

// ─── rotateRefreshToken ───────────────────────────────────────────────────────

describe("rotateRefreshToken", () => {
  const OLD_TOKEN = "old_refresh_token";
  const NEW_TOKEN = "new_refresh_token";
  const ACCESS_TOKEN = "new_access_token";

  const DECODED = {
    userId: "user-123",
    familyId: "family-abc",
    tokenId: "token-old",
    iat: 1000,
    exp: 2000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyRefreshToken.mockResolvedValue(DECODED);
    mockGenerateToken.mockReturnValue(ACCESS_TOKEN);
    mockGenerateRefreshToken.mockResolvedValue(NEW_TOKEN);
    mockQueryRead.mockResolvedValue({ rows: [{ phone_number: "237677001122" }] });
    mockQueryWrite.mockResolvedValue({ rowCount: 1 });
  });

  it("returns new access and refresh tokens", async () => {
    const result = await rotateRefreshToken(OLD_TOKEN, {
      deviceId: "dev-001",
      deviceName: "iPhone 15",
      ipAddress: "1.2.3.4",
      userAgent: "Mozilla/5.0",
    });

    expect(result.accessToken).toBe(ACCESS_TOKEN);
    expect(result.refreshToken).toBe(NEW_TOKEN);
    expect(result.deviceId).toBe("dev-001");
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it("calls generateRefreshToken with correct family and parent token", async () => {
    await rotateRefreshToken(OLD_TOKEN);

    expect(mockGenerateRefreshToken).toHaveBeenCalledWith(
      DECODED.userId,
      DECODED.familyId,
      DECODED.tokenId,
    );
  });

  it("generates a deviceId if none is provided", async () => {
    const result = await rotateRefreshToken(OLD_TOKEN, {
      ipAddress: "5.6.7.8",
    });
    expect(typeof result.deviceId).toBe("string");
    expect(result.deviceId.length).toBeGreaterThan(0);
  });

  it("updates device metadata for the new token", async () => {
    await rotateRefreshToken(OLD_TOKEN, {
      deviceId: "dev-001",
      deviceName: "Android Phone",
      ipAddress: "10.0.0.1",
      userAgent: "okhttp/4.9.0",
    });

    // The first queryWrite call should set device metadata on the new token
    const firstWriteArgs = mockQueryWrite.mock.calls[0];
    expect(firstWriteArgs[0]).toContain("UPDATE refresh_token_families");
    expect(firstWriteArgs[1]).toContain("dev-001");
    expect(firstWriteArgs[1]).toContain("Android Phone");
  });

  it("throws when verifyRefreshToken throws (invalid/reused token)", async () => {
    mockVerifyRefreshToken.mockRejectedValue(new Error("Refresh token reuse detected"));

    await expect(rotateRefreshToken(OLD_TOKEN)).rejects.toThrow(
      "Refresh token reuse detected",
    );
  });

  it("uses provided userEmail instead of DB lookup", async () => {
    await rotateRefreshToken(OLD_TOKEN, {}, "custom@email.com");
    expect(mockGenerateToken).toHaveBeenCalledWith(
      expect.objectContaining({ email: "custom@email.com" }),
    );
    // DB should not have been queried for email
    expect(mockQueryRead).not.toHaveBeenCalled();
  });
});

// ─── listActiveSessions ───────────────────────────────────────────────────────

describe("listActiveSessions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns mapped session objects", async () => {
    mockQueryRead.mockResolvedValue({
      rows: [
        {
          family_id: "fam-1",
          device_id: "dev-1",
          device_name: "iPhone",
          ip_address: "1.2.3.4",
          user_agent: "Safari",
          issued_at: new Date("2026-01-01"),
          last_used_at: new Date("2026-01-02"),
          expires_at: new Date("2026-01-08"),
        },
      ],
    });

    const sessions = await listActiveSessions("user-123");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].familyId).toBe("fam-1");
    expect(sessions[0].deviceId).toBe("dev-1");
    expect(sessions[0].deviceName).toBe("iPhone");
  });

  it("returns empty array when no active sessions", async () => {
    mockQueryRead.mockResolvedValue({ rows: [] });
    const sessions = await listActiveSessions("user-xyz");
    expect(sessions).toEqual([]);
  });
});

// ─── logoutSession ────────────────────────────────────────────────────────────

describe("logoutSession", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryWrite.mockResolvedValue({ rowCount: 1 });
  });

  it("issues an UPDATE query to revoke the family", async () => {
    await logoutSession("user-123", "fam-abc");

    const [sql, params] = mockQueryWrite.mock.calls[0];
    expect(sql).toContain("UPDATE refresh_token_families");
    expect(sql).toContain("is_revoked = TRUE");
    expect(params).toContain("user-123");
    expect(params).toContain("fam-abc");
  });
});

// ─── logoutAllSessions ────────────────────────────────────────────────────────

describe("logoutAllSessions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the number of revoked rows", async () => {
    mockQueryWrite.mockResolvedValue({ rowCount: 3 });
    const count = await logoutAllSessions("user-123");
    expect(count).toBe(3);
  });

  it("issues UPDATE with is_revoked = TRUE for all user tokens", async () => {
    mockQueryWrite.mockResolvedValue({ rowCount: 2 });
    await logoutAllSessions("user-abc");

    const [sql, params] = mockQueryWrite.mock.calls[0];
    expect(sql).toContain("is_revoked = FALSE");
    expect(params).toContain("user-abc");
  });

  it("returns 0 when no active sessions exist", async () => {
    mockQueryWrite.mockResolvedValue({ rowCount: 0 });
    const count = await logoutAllSessions("user-no-sessions");
    expect(count).toBe(0);
  });
});

// ─── recordInitialDeviceInfo ──────────────────────────────────────────────────

describe("recordInitialDeviceInfo", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryWrite.mockResolvedValue({ rowCount: 1 });
  });

  it("writes device info to the DB for the given token", async () => {
    await recordInitialDeviceInfo("my_refresh_token", {
      deviceId: "dev-999",
      deviceName: "Pixel 7",
      ipAddress: "192.168.1.1",
      userAgent: "Chrome/120",
    });

    const [sql, params] = mockQueryWrite.mock.calls[0];
    expect(sql).toContain("UPDATE refresh_token_families");
    expect(params).toContain("dev-999");
    expect(params).toContain("Pixel 7");
    expect(params).toContain("my_refresh_token");
  });

  it("generates a deviceId if none is provided", async () => {
    await recordInitialDeviceInfo("token_xyz", {});

    const [, params] = mockQueryWrite.mock.calls[0];
    const deviceId = params[0] as string;
    expect(typeof deviceId).toBe("string");
    expect(deviceId.length).toBeGreaterThan(0);
  });
});
