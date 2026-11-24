import {
  safeParseInt,
  safeParseFloat,
  safeParseDurationMs,
  ConfigurationError,
} from "../../src/utils/safeParseInt";

describe("safeParseInt and runtime configuration parsing", () => {
  describe("safeParseInt", () => {
    it("parses valid integer strings correctly", () => {
      expect(safeParseInt("42", 10)).toBe(42);
      expect(safeParseInt("0", 10)).toBe(0);
      expect(safeParseInt("-5", 10)).toBe(-5);
      expect(safeParseInt("  100  ", 10)).toBe(100);
    });

    it("returns default value for undefined, null, or empty string", () => {
      expect(safeParseInt(undefined, 25)).toBe(25);
      expect(safeParseInt(null, 25)).toBe(25);
      expect(safeParseInt("", 25)).toBe(25);
      expect(safeParseInt("   ", 25)).toBe(25);
    });

    it("handles non-integer and malformed strings safely without NaN poisoning", () => {
      expect(safeParseInt("abc", 50)).toBe(50);
      expect(safeParseInt("12.34", 50)).toBe(50);
      expect(safeParseInt("100px", 50)).toBe(50);
      expect(safeParseInt("NaN", 50)).toBe(50);
    });

    it("throws ConfigurationError in strict mode when string is invalid", () => {
      expect(() => {
        safeParseInt("invalid_number", 50, { strict: true, varName: "DB_POOL_SIZE" });
      }).toThrow(ConfigurationError);
    });

    it("enforces minimum bounds", () => {
      expect(safeParseInt("5", 10, { min: 10 })).toBe(10);
      expect(safeParseInt("15", 10, { min: 10 })).toBe(15);
    });

    it("enforces maximum bounds", () => {
      expect(safeParseInt("500", 100, { max: 100 })).toBe(100);
      expect(safeParseInt("80", 100, { max: 100 })).toBe(80);
    });
  });

  describe("safeParseFloat", () => {
    it("parses valid floats and bounds correctly", () => {
      expect(safeParseFloat("1.5", 0)).toBe(1.5);
      expect(safeParseFloat("0.005", 0)).toBe(0.005);
      expect(safeParseFloat("abc", 2.5)).toBe(2.5);
      expect(safeParseFloat("10.5", 5, { max: 8 })).toBe(8);
    });
  });

  describe("safeParseDurationMs", () => {
    it("parses durations with units into milliseconds", () => {
      expect(safeParseDurationMs("500ms", 1000)).toBe(500);
      expect(safeParseDurationMs("30s", 1000)).toBe(30000);
      expect(safeParseDurationMs("5m", 1000)).toBe(300000);
      expect(safeParseDurationMs("2h", 1000)).toBe(7200000);
      expect(safeParseDurationMs("1d", 1000)).toBe(86400000);
    });

    it("handles raw numbers or fallback for invalid durations", () => {
      expect(safeParseDurationMs("5000", 1000)).toBe(5000);
      expect(safeParseDurationMs("invalid_duration", 3000)).toBe(3000);
      expect(safeParseDurationMs(undefined, 3000)).toBe(3000);
    });
  });
});
