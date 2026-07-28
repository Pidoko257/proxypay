import fc from "fast-check";
import { z } from "zod";

const phoneSchema = z
  .string()
  .regex(/^\+?\d{10,15}$/, { message: "Invalid phone number format" });

const amountSchema = z.number().positive({
  message: "Amount must be a positive number",
});

const transactionIdSchema = z.string().min(1, { message: "transactionId is required" });

const providerSchema = z.enum(["MTN", "AIRTEL", "ORANGE"], {
  message: "Provider must be one of: MTN, AIRTEL, ORANGE",
});

describe("Fuzz tests for input validation", () => {
  describe("phone number validation", () => {
    it("accepts valid phone numbers", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string({ minLength: 10, maxLength: 15 }).filter((s) => /^\d+$/.test(s)),
            fc
              .string({ minLength: 11, maxLength: 16 })
              .filter((s) => s.startsWith("+") && /^\+\d+$/.test(s)),
          ),
          (phone) => {
            const result = phoneSchema.safeParse(phone);
            expect(result.success).toBe(true);
          },
        ),
        { seed: 42, numRuns: 100 },
      );
    });

    it("rejects invalid phone numbers", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string({ minLength: 0, maxLength: 9 }),
            fc.string({ minLength: 16 }),
            fc.string().filter((s) => s.length > 0 && !/^\+?\d+$/.test(s)),
          ),
          (phone) => {
            const result = phoneSchema.safeParse(phone);
            expect(result.success).toBe(false);
          },
        ),
        { seed: 42, numRuns: 100 },
      );
    });

    it("handles edge cases: empty string, null, undefined, numbers, objects", () => {
      const edgeCases: unknown[] = [
        "",
        null,
        undefined,
        12345,
        {},
        [],
        true,
        false,
        "   ",
        "+",
        "12345678901234567890",
      ];

      for (const input of edgeCases) {
        const result = phoneSchema.safeParse(input as string);
        expect(result.success).toBe(false);
      }
    });
  });

  describe("amount validation", () => {
    it("accepts positive finite numbers", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0.001, max: 1_000_000, noNaN: true, noInfinity: true }),
          (amount) => {
            const result = amountSchema.safeParse(amount);
            expect(result.success).toBe(true);
          },
        ),
        { seed: 42, numRuns: 100 },
      );
    });

    it("rejects non-positive and non-finite amounts", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.double({ max: 0, noNaN: true, noInfinity: true }),
            fc.double({ noNaN: false }),
            fc.double({ noInfinity: false }),
          ),
          (amount) => {
            const result = amountSchema.safeParse(amount);
            expect(result.success).toBe(false);
          },
        ),
        { seed: 42, numRuns: 100 },
      );
    });

    it("handles edge cases: zero, negative, NaN, Infinity, strings, null", () => {
      const edgeCases: unknown[] = [
        0,
        -1,
        NaN,
        Infinity,
        -Infinity,
        "100",
        null,
        undefined,
        {},
        [],
      ];

      for (const input of edgeCases) {
        const result = amountSchema.safeParse(input);
        expect(result.success).toBe(false);
      }
    });
  });

  describe("transaction ID validation", () => {
    it("accepts non-empty strings", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          (txId) => {
            const result = transactionIdSchema.safeParse(txId);
            expect(result.success).toBe(true);
          },
        ),
        { seed: 42, numRuns: 100 },
      );
    });

    it("rejects empty or non-string inputs", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string({ maxLength: 0 }),
            fc.integer(),
            fc.boolean(),
            fc.constant(null, undefined),
          ),
          (txId) => {
            const result = transactionIdSchema.safeParse(txId);
            expect(result.success).toBe(false);
          },
        ),
        { seed: 42, numRuns: 100 },
      );
    });
  });

  describe("provider enum validation", () => {
    it("accepts valid providers", () => {
      fc.assert(
        fc.property(
          fc.constantFrom("MTN", "AIRTEL", "ORANGE"),
          (provider) => {
            const result = providerSchema.safeParse(provider);
            expect(result.success).toBe(true);
          },
        ),
        { seed: 42, numRuns: 100 },
      );
    });

    it("rejects invalid providers", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string({ minLength: 1 }).filter((s) => !["MTN", "AIRTEL", "ORANGE"].includes(s)),
            fc.integer(),
            fc.boolean(),
            fc.constant(null, undefined),
          ),
          (provider) => {
            const result = providerSchema.safeParse(provider);
            expect(result.success).toBe(false);
          },
        ),
        { seed: 42, numRuns: 100 },
      );
    });
  });

  describe("discovered edge cases", () => {
    it("documents edge case: extremely long strings", () => {
      const longString = "a".repeat(100000);
      expect(phoneSchema.safeParse(longString).success).toBe(false);
      expect(amountSchema.safeParse(longString).success).toBe(false);
    });

    it("documents edge case: unicode and special characters in phone", () => {
      const unicodePhones = ["+1234567890", "123-456-7890", "123.456.7890", "①②③④⑤⑥⑦⑧⑨"];
      for (const phone of unicodePhones) {
        const result = phoneSchema.safeParse(phone);
        expect(result.success).toBe(false);
      }
    });

    it("documents edge case: whitespace-only strings", () => {
      const whitespace = [" ", "  ", "\t", "\n", " \t\n "];
      for (const ws of whitespace) {
        expect(phoneSchema.safeParse(ws).success).toBe(false);
        expect(transactionIdSchema.safeParse(ws).success).toBe(false);
      }
    });
  });
});
