import { describe, expect, it } from "@jest/globals";
import { encrypt, decrypt, deterministicLookupValues } from "../../src/utils/encryption";

const ivOf = (ciphertext: string) => ciphertext.split(":")[0];

describe("deterministic (searchable) encryption", () => {
  it("is deterministic for the same plaintext", () => {
    expect(encrypt("+237670000001", true)).toBe(encrypt("+237670000001", true));
  });

  it("never reuses an IV across different plaintexts", () => {
    const a = encrypt("+237670000001", true) as string;
    const b = encrypt("+237670000002", true) as string;
    expect(ivOf(a)).not.toBe(ivOf(b));
  });

  it("does not use the all-zero IV", () => {
    const c = encrypt("+237670000001", true) as string;
    expect(ivOf(c)).not.toBe("0".repeat(24));
    expect(ivOf(c)).toHaveLength(24);
  });

  it("round-trips through decrypt()", () => {
    const c = encrypt("+237670000003", true);
    expect(decrypt(c)).toBe("+237670000003");
  });

  it("still uses a random IV in non-deterministic mode", () => {
    expect(encrypt("+237670000004")).not.toBe(encrypt("+237670000004"));
  });

  describe("deterministicLookupValues", () => {
    it("returns the current form first and the legacy zero-IV form second", () => {
      const [current, legacy] = deterministicLookupValues("+237670000005");
      expect(current).toBe(encrypt("+237670000005", true));
      expect(ivOf(legacy)).toBe("0".repeat(24));
      // Legacy rows must still decrypt so existing users keep working.
      expect(decrypt(legacy)).toBe("+237670000005");
    });
  });
});
