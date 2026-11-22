import { describe, expect, it, afterEach, jest } from "@jest/globals";

/**
 * The HKDF salt must come from DB_ENCRYPTION_HKDF_SALT, not a hard-coded
 * constant, so that it can be kept secret and rotated.
 */
describe("deriveKey HKDF salt", () => {
  const originalSalt = process.env.DB_ENCRYPTION_HKDF_SALT;

  afterEach(() => {
    process.env.DB_ENCRYPTION_HKDF_SALT = originalSalt;
    jest.resetModules();
  });

  function loadDeriveKey(salt: string): (keyMaterial: string, info?: string) => Buffer {
    process.env.DB_ENCRYPTION_HKDF_SALT = salt;
    let fn!: (keyMaterial: string, info?: string) => Buffer;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      fn = require("../../src/utils/encryption").deriveKey;
    });
    return fn;
  }

  it("derives different keys for different configured salts", () => {
    const keyA = loadDeriveKey("salt-a")("same-key-material");
    const keyB = loadDeriveKey("salt-b")("same-key-material");
    expect(keyA.length).toBe(32);
    expect(keyA.equals(keyB)).toBe(false);
  });

  it("is stable for the same configured salt", () => {
    const keyA = loadDeriveKey("salt-a")("same-key-material");
    const keyA2 = loadDeriveKey("salt-a")("same-key-material");
    expect(keyA.equals(keyA2)).toBe(true);
  });

  it("refuses to load when DB_ENCRYPTION_HKDF_SALT is missing", () => {
    delete process.env.DB_ENCRYPTION_HKDF_SALT;
    const exit = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require("../../src/utils/encryption");
        }),
      ).toThrow();
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });
});
