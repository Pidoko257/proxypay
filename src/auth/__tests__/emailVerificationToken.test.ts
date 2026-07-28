import { redisClient } from "../../config/redis";
import jwt from "jsonwebtoken";
import {
  issueEmailVerificationToken,
  consumeEmailVerificationToken,
  revokeEmailVerificationToken,
  decodeEmailVerificationToken,
  EMAIL_VERIFICATION_TTL_SECONDS,
} from "../emailVerification";

jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    quit: jest.fn(),
  },
}));

describe("Email Verification Token", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "test-secret-for-email-verification";
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  describe("issueEmailVerificationToken", () => {
    it("should issue a valid JWT with 24h expiry and store in Redis", async () => {
      const { token, tokenId, expiresInSeconds } =
        await issueEmailVerificationToken("user-1");

      expect(expiresInSeconds).toBe(EMAIL_VERIFICATION_TTL_SECONDS);
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3);
      expect(typeof tokenId).toBe("string");

      expect(redisClient.set).toHaveBeenCalledWith(
        `verify_email:${tokenId}`,
        "user-1",
        { EX: EMAIL_VERIFICATION_TTL_SECONDS },
      );
    });

    it("should not store in Redis when Redis is not open", async () => {
      (redisClient as any).isOpen = false;

      const { token, tokenId } = await issueEmailVerificationToken("user-2");

      expect(token).toBeDefined();
      expect(tokenId).toBeDefined();
      expect(redisClient.set).not.toHaveBeenCalled();

      (redisClient as any).isOpen = true;
    });
  });

  describe("decodeEmailVerificationToken", () => {
    it("should decode a valid token and return remainingSeconds > 0", async () => {
      const { token } = await issueEmailVerificationToken("user-42");
      const decoded = decodeEmailVerificationToken(token);

      expect(decoded.userId).toBe("user-42");
      expect(decoded.purpose).toBe("email_verification");
      expect(decoded.tokenId).toBeDefined();
      expect(decoded.remainingSeconds).toBeGreaterThan(0);
    });

    it("should reject tokens with wrong purpose", async () => {
      const token = jwt.sign(
        { userId: "user-1", purpose: "wrong_purpose", tokenId: "abc" },
        process.env.JWT_SECRET!,
        { expiresIn: "24h" },
      );

      expect(() => decodeEmailVerificationToken(token)).toThrow(
        "Token was not issued for email verification",
      );
    });

    it("should throw on an invalid token", () => {
      expect(() => decodeEmailVerificationToken("not.a.token")).toThrow(
        "Invalid email verification token",
      );
    });

    it("should throw on expired token", () => {
      const expired = jwt.sign(
        { userId: "x", purpose: "email_verification", tokenId: "x" },
        process.env.JWT_SECRET!,
        { expiresIn: 0 },
      );

      // allow a moment for the JWT to actually expire
      expect(() => decodeEmailVerificationToken(expired)).toThrow(
        "Email verification token has expired",
      );
    });
  });

  describe("consumeEmailVerificationToken", () => {
    it("should consume a valid token and delete the Redis key", async () => {
      const { token, tokenId } = await issueEmailVerificationToken("user-7");

      (redisClient.get as jest.Mock).mockResolvedValueOnce("user-7");

      const result = await consumeEmailVerificationToken(token);

      expect(result.userId).toBe("user-7");
      expect(result.tokenId).toBe(tokenId);
      expect(redisClient.del).toHaveBeenCalledWith(`verify_email:${tokenId}`);
    });

    it("should throw if the Redis entry is missing (already consumed)", async () => {
      const { token } = await issueEmailVerificationToken("user-8");

      (redisClient.get as jest.Mock).mockResolvedValueOnce(null);

      await expect(consumeEmailVerificationToken(token)).rejects.toThrow(
        "Email verification token has been used or revoked",
      );
    });
  });

  describe("revokeEmailVerificationToken", () => {
    it("should delete the Redis key when Redis is open", async () => {
      await revokeEmailVerificationToken("tok-abc");
      expect(redisClient.del).toHaveBeenCalledWith("verify_email:tok-abc");
    });

    it("should not attempt a Redis call when Redis is not open", async () => {
      (redisClient as any).isOpen = false;
      await revokeEmailVerificationToken("tok-xyz");
      expect(redisClient.del).not.toHaveBeenCalled();
      (redisClient as any).isOpen = true;
    });
  });
});