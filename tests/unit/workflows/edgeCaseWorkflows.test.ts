import { calculateFeeSync } from "../../../src/utils/fees";
import { TransactionStatus } from "../../../src/models/transaction";
import { transactionStatusWorkflowService } from "../../../src/services/transactionStatusWorkflowService";

describe("Workflow Edge Cases (Amount, Fee, Cursor, Status)", () => {
  beforeEach(() => {
    process.env.FEE_PERCENTAGE = "1.5";
    process.env.FEE_MINIMUM = "50";
    process.env.FEE_MAXIMUM = "5000";
  });

  describe("Amount and Fee Workflow Edge Cases", () => {
    // Parameterized boundary tests across various order of magnitude amounts
    const amountCases = [
      { amount: 0, expectedFee: 50, desc: "zero amount clamps to minimum fee" },
      { amount: 0.0000001, expectedFee: 50, desc: "smallest Stellar 7-decimal stroop unit" },
      { amount: 0.01, expectedFee: 50, desc: "fractional 1 cent" },
      { amount: 3333.33, expectedFee: 50, desc: "just below minimum fee threshold" },
      { amount: 3333.34, expectedFee: 50.0001, desc: "just above minimum fee threshold" },
      { amount: 10000, expectedFee: 150, desc: "standard mid-range amount" },
      { amount: 333333.33, expectedFee: 5000, desc: "at maximum fee cap" },
      { amount: 1000000, expectedFee: 5000, desc: "large amount clamped at maximum fee cap" },
      { amount: 100000000, expectedFee: 5000, desc: "extreme institutional amount clamped at maximum" },
    ];

    amountCases.forEach(({ amount, expectedFee, desc }) => {
      it(`calculates correct fee for ${desc} (amount: ${amount})`, () => {
        const result = calculateFeeSync(amount);
        expect(result.fee).toBeCloseTo(expectedFee, 2);
        expect(result.total).toBeCloseTo(amount + result.fee, 2);
      });
    });

    it("handles boundary transitions where percentage fee equals minimum fee", () => {
      // 50 / 0.015 = 3333.333...
      const resultLower = calculateFeeSync(3333);
      const resultUpper = calculateFeeSync(3334);

      expect(resultLower.fee).toBe(50);
      expect(resultUpper.fee).toBeGreaterThanOrEqual(50);
    });

    it("handles boundary transitions where percentage fee equals maximum fee", () => {
      // 5000 / 0.015 = 333333.333...
      const resultLower = calculateFeeSync(333333);
      const resultUpper = calculateFeeSync(333334);

      expect(resultLower.fee).toBeLessThanOrEqual(5000);
      expect(resultUpper.fee).toBe(5000);
    });
  });

  describe("Cursor Encoding and Decoding Edge Cases", () => {
    function decodeCursorHelper(cursor: string): { createdAt: Date; id: string } {
      const decoded = Buffer.from(cursor, "base64").toString("utf8");
      const separator = decoded.lastIndexOf("|");
      if (separator === -1) {
        throw new Error("Invalid transaction cursor");
      }
      const createdAt = new Date(decoded.slice(0, separator));
      const id = decoded.slice(separator + 1);
      if (Number.isNaN(createdAt.getTime()) || !id) {
        throw new Error("Invalid transaction cursor");
      }
      return { createdAt, id };
    }

    function encodeCursorHelper(date: Date, id: string): string {
      return Buffer.from(`${date.toISOString()}|${id}`).toString("base64");
    }

    it("encodes and decodes normal cursor roundtrip", () => {
      const date = new Date("2026-05-15T12:00:00.000Z");
      const id = "txn_abc123";
      const cursor = encodeCursorHelper(date, id);
      const decoded = decodeCursorHelper(cursor);

      expect(decoded.createdAt.toISOString()).toBe(date.toISOString());
      expect(decoded.id).toBe(id);
    });

    it("handles IDs containing pipe characters correctly using lastIndexOf separator", () => {
      const date = new Date("2026-01-01T00:00:00.000Z");
      const idWithPipes = "part1|part2|part3";
      const cursor = encodeCursorHelper(date, idWithPipes);
      const decoded = decodeCursorHelper(cursor);

      expect(decoded.id).toBe(idWithPipes);
      expect(decoded.createdAt.toISOString()).toBe(date.toISOString());
    });

    const malformedCursors = [
      { input: "", desc: "empty string" },
      { input: "not-base-64!!", desc: "invalid base64 encoding without delimiter" },
      { input: Buffer.from("invalid-date|id123").toString("base64"), desc: "invalid date format" },
      { input: Buffer.from("2026-01-01T00:00:00.000Z|").toString("base64"), desc: "missing id after separator" },
      { input: Buffer.from("|id123").toString("base64"), desc: "missing date before separator" },
      { input: Buffer.from("no-separator-here").toString("base64"), desc: "missing separator" },
    ];

    malformedCursors.forEach(({ input, desc }) => {
      it(`rejects malformed cursor: ${desc}`, () => {
        expect(() => decodeCursorHelper(input)).toThrow("Invalid transaction cursor");
      });
    });

    it("handles epoch zero and future dates correctly", () => {
      const epochZero = new Date(0);
      const futureDate = new Date("2099-12-31T23:59:59.999Z");

      const cursorEpoch = encodeCursorHelper(epochZero, "id_epoch");
      const decodedEpoch = decodeCursorHelper(cursorEpoch);
      expect(decodedEpoch.createdAt.getTime()).toBe(0);

      const cursorFuture = encodeCursorHelper(futureDate, "id_future");
      const decodedFuture = decodeCursorHelper(cursorFuture);
      expect(decodedFuture.createdAt.getTime()).toBe(futureDate.getTime());
    });
  });

  describe("Transaction Status Workflow Cartesian Transitions", () => {
    const allStatuses = Object.values(TransactionStatus);

    it("verifies full status transition matrix consistency", () => {
      for (const from of allStatuses) {
        const allowed = transactionStatusWorkflowService.getAllowedBaseTransitions(from);

        for (const to of allStatuses) {
          const isValid = transactionStatusWorkflowService.isValidBaseTransition(from, to);
          if (from === to) {
            // Identity transition is always idempotent
            expect(isValid).toBe(true);
          } else if (allowed.includes(to)) {
            expect(isValid).toBe(true);
          } else {
            expect(isValid).toBe(false);
          }
        }
      }
    });

    it("verifies terminal statuses have no valid transitions to other states", () => {
      const terminalStates = [
        TransactionStatus.Failed,
        TransactionStatus.Cancelled,
        TransactionStatus.Reversed,
        TransactionStatus.ClawedBack,
      ];

      for (const terminal of terminalStates) {
        for (const target of allStatuses) {
          if (terminal !== target) {
            expect(transactionStatusWorkflowService.isValidBaseTransition(terminal, target)).toBe(false);
          }
        }
      }
    });
  });
});
