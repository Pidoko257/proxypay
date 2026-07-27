import { buildRequestFingerprint, isDeduplicationBypassed, isAdminRequest } from "../../src/middleware/requestDeduplication";

describe("request deduplication unit helpers", () => {
  describe("isAdminRequest", () => {
    it("returns true for admin role", () => {
      expect(isAdminRequest({ user: { role: "admin" } } as any)).toBe(true);
    });

    it("returns true for super-admin role", () => {
      expect(isAdminRequest({ user: { role: "super-admin" } } as any)).toBe(true);
    });

    it("returns false for non-admin", () => {
      expect(isAdminRequest({ user: { role: "user" } } as any)).toBe(false);
    });

    it("returns false when no user", () => {
      expect(isAdminRequest({} as any)).toBe(false);
    });
  });

  describe("isDeduplicationBypassed", () => {
    const env = process.env;

    beforeEach(() => {
      delete process.env.DEDUPLICATION_ADMIN_BYPASS;
    });

    afterEach(() => {
      process.env = env;
    });

    it("returns true when header is set to true", () => {
      expect(isDeduplicationBypassed({
        get: (_key: string) => "true",
      } as any)).toBe(true);
    });

    it("returns true when env var is set", () => {
      process.env.DEDUPLICATION_ADMIN_BYPASS = "true";
      expect(isDeduplicationBypassed({} as any)).toBe(true);
    });

    it("returns false when neither header nor env is set", () => {
      expect(isDeduplicationBypassed({
        get: undefined,
        headers: {},
      } as any)).toBe(false);
    });
  });
});
