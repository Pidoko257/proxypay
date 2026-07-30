import express from "express";
import request from "supertest";
import { requireVerifiedEmail } from "../../middleware/emailVerified";
import { errorHandler } from "../../middleware/errorHandler";

jest.mock("../../config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

describe("requireVerifiedEmail middleware", () => {
  let app: express.Application;
  const mockQueryRead = require("../../config/database").queryRead as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());

    app.get(
      "/protected",
      (req: any, _res, next) => {
        req.jwtUser = { userId: "user-1", email: "test@example.com", role: "user" };
        next();
      },
      requireVerifiedEmail,
      (_req, res) => {
        res.json({ ok: true });
      },
    );

    app.get("/no-auth", requireVerifiedEmail, (_, res) => {
      res.json({ ok: true });
    });

    app.use(errorHandler);
  });


  it("should allow request when email_verified is true", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [{ email_verified: true }],
    });

    const res = await request(app).get("/protected");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("should return 403 with ERR_EMAIL_UNVERIFIED when email_verified is false", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [{ email_verified: false }],
    });

    const res = await request(app).get("/protected");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EMAIL_UNVERIFIED");
    if (process.env.NODE_ENV !== "production") {
      expect(res.body.details?.error).toBe("ERR_EMAIL_UNVERIFIED");
    }
  });

  it("should return 403 with ERR_EMAIL_UNVERIFIED when email_verified is null", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [{ email_verified: null }],
    });

    const res = await request(app).get("/protected");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EMAIL_UNVERIFIED");
  });

  it("should return 401 when req.jwtUser is not set", async () => {
    const res = await request(app).get("/no-auth");

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });
});