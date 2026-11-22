import { describe, expect, it, afterEach, jest } from "@jest/globals";
import { encryptField, decryptField, decryptFieldOrNull } from "../../src/utils/encryption";

/** Flip the last hex nibble of the ciphertext so GCM authentication fails. */
function tamper(payload: string): string {
  const last = payload.slice(-1);
  return payload.slice(0, -1) + (last === "0" ? "1" : "0");
}

describe("decryptField failure handling", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it("throws (instead of returning ciphertext) for a tampered legacy-format payload", () => {
    const encrypted = encryptField("Jane") as string;
    expect(() => decryptField(tamper(encrypted))).toThrow(/PII decryption failed/);
  });

  it("throws (instead of returning ciphertext) for a tampered versioned payload", () => {
    process.env.ACTIVE_ENCRYPTION_KEY_VERSION = "v1";
    process.env.DB_ENCRYPTION_KEY_V1 = "dynamic-key-v1-32-characters!!!!";
    const encrypted = encryptField("Jane") as string;
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(() => decryptField(tamper(encrypted))).toThrow(/PII decryption failed/);
  });

  it("throws when a versioned payload is malformed", () => {
    process.env.DB_ENCRYPTION_KEY_V1 = "dynamic-key-v1-32-characters!!!!";
    expect(() => decryptField("v1:aa:bb:cc:dd")).toThrow();
  });

  it("passes through values that are not encrypted payloads (pre-encryption rows)", () => {
    expect(decryptField("plain legacy value")).toBe("plain legacy value");
    expect(decryptField("ya29.oauth-token-without-colons")).toBe("ya29.oauth-token-without-colons");
  });

  describe("decryptFieldOrNull", () => {
    it("returns plaintext on success", () => {
      expect(decryptFieldOrNull(encryptField("Jane"), "test")).toBe("Jane");
    });

    it("returns null (never ciphertext) on failure and logs a warning without the value", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const bad = tamper(encryptField("Jane") as string);
      expect(decryptFieldOrNull(bad, "users.first_name")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain("users.first_name");
      expect(message).not.toContain(bad);
    });

    it("preserves null/undefined/empty", () => {
      expect(decryptFieldOrNull(null, "x")).toBeNull();
      expect(decryptFieldOrNull(undefined, "x")).toBeUndefined();
      expect(decryptFieldOrNull("", "x")).toBe("");
    });
  });
});
