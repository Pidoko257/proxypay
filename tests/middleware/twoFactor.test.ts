import express, { Request, Response, NextFunction } from "express";
import request from "supertest";

jest.mock("../../src/auth/2fa", () => ({
  verifyTOTPToken: jest.fn(),
  verifyBackupCode: jest.fn(),
  is2FAEnabled: jest.fn(),
}));

jest.mock("../../src/services/twoFactorRateLimiter", () => ({
  twoFactorRateLimiter: {
    isLocked: jest.fn().mockResolvedValue(false),
    getLockoutTimeRemaining: jest.fn().mockResolvedValue(0),
    resetFailures: jest.fn().mockResolvedValue(undefined),
    incrementFailures: jest.fn().mockResolvedValue(1),
  },
}));

import { verifyTOTPToken, is2FAEnabled } from "../../src/auth/2fa";
import {
  requireTwoFactor,
  optionalTwoFactor,
} from "../../src/middleware/twoFactor";

const user = { id: "user-1", two_factor_secret: "SECRET", backup_codes: null };

function buildApp(guard: typeof requireTwoFactor, opts: { authed?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (opts.authed !== false) {
      req.jwtUser = { userId: user.id };
      res.locals.user = user;
    }
    next();
  });
  app.post("/protected", guard, (req: Request, res: Response) => {
    res.status(200).json({ ok: true, verified: req.twoFactorVerified });
  });
  return app;
}

describe("requireTwoFactor middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (is2FAEnabled as jest.Mock).mockReturnValue(true);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp(requireTwoFactor, { authed: false })).post("/protected");
    expect(res.status).toBe(401);
  });

  it("blocks the route when 2FA is enabled and no token is provided", async () => {
    const res = await request(buildApp(requireTwoFactor)).post("/protected").send({});
    expect(res.status).toBe(403);
    expect(res.body.required).toBe(true);
  });

  it("blocks the route when the TOTP token is invalid", async () => {
    (verifyTOTPToken as jest.Mock).mockReturnValue(false);
    const res = await request(buildApp(requireTwoFactor))
      .post("/protected")
      .set("X-2FA-Token", "000000");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Invalid 2FA");
  });

  it("allows the route with a valid TOTP token", async () => {
    (verifyTOTPToken as jest.Mock).mockReturnValue(true);
    const res = await request(buildApp(requireTwoFactor))
      .post("/protected")
      .set("X-2FA-Token", "123456");
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });

  it("allows the route when 2FA is not enabled for the user", async () => {
    (is2FAEnabled as jest.Mock).mockReturnValue(false);
    const res = await request(buildApp(requireTwoFactor)).post("/protected");
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });
});

describe("optionalTwoFactor middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (is2FAEnabled as jest.Mock).mockReturnValue(true);
  });

  it("runs and marks the request unverified when no token is provided", async () => {
    const res = await request(buildApp(optionalTwoFactor)).post("/protected");
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);
  });

  it("marks the request verified with a valid TOTP token", async () => {
    (verifyTOTPToken as jest.Mock).mockReturnValue(true);
    const res = await request(buildApp(optionalTwoFactor))
      .post("/protected")
      .set("X-2FA-Token", "123456");
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });
});
