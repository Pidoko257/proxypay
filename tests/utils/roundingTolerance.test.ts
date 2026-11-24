import {
  ROUNDING_TOLERANCE,
  isWithinTolerance,
  getRoundingError,
  isRoundingError,
  roundToNearestCent,
  formatAmount,
  isValidMonetaryAmount,
} from "../../src/utils/roundingTolerance";

describe("Rounding Tolerance Utilities", () => {
  describe("ROUNDING_TOLERANCE constant", () => {
    it("should be set to 0.01", () => {
      expect(ROUNDING_TOLERANCE).toBe(0.01);
    });
  });

  describe("isWithinTolerance", () => {
    it("should return true when amounts are equal", () => {
      expect(isWithinTolerance(100.00, 100.00)).toBe(true);
    });

    it("should return true for small positive differences", () => {
      expect(isWithinTolerance(100.00, 100.001)).toBe(true);
      expect(isWithinTolerance(100.00, 100.005)).toBe(true);
      expect(isWithinTolerance(100.00, 100.009)).toBe(true);
    });

    it("should return true for small negative differences", () => {
      expect(isWithinTolerance(100.00, 99.999)).toBe(true);
      expect(isWithinTolerance(100.00, 99.995)).toBe(true);
      expect(isWithinTolerance(100.00, 99.991)).toBe(true);
    });

    it("should return true for exact tolerance boundary", () => {
      expect(isWithinTolerance(100.00, 100.01)).toBe(true);
      expect(isWithinTolerance(100.00, 99.99)).toBe(true);
    });

    it("should return false for differences exceeding tolerance", () => {
      expect(isWithinTolerance(100.00, 100.011)).toBe(false);
      expect(isWithinTolerance(100.00, 100.02)).toBe(false);
      expect(isWithinTolerance(100.00, 99.989)).toBe(false);
    });

    it("should support custom tolerance", () => {
      expect(isWithinTolerance(100.00, 100.05, 0.1)).toBe(true);
      expect(isWithinTolerance(100.00, 100.05, 0.01)).toBe(false);
      // Use toBeCloseTo for this edge case due to floating-point precision
      expect(isWithinTolerance(100.00, 100.001, 0.001)).toBe(true);
    });

    it("should handle negative amounts", () => {
      expect(isWithinTolerance(-100.00, -100.005)).toBe(true);
      expect(isWithinTolerance(-100.00, -100.02)).toBe(false);
    });

    it("should handle large amounts", () => {
      expect(isWithinTolerance(1000000.00, 1000000.005)).toBe(true);
      expect(isWithinTolerance(1000000.00, 1000000.02)).toBe(false);
    });
  });

  describe("getRoundingError", () => {
    it("should return zero when amounts are equal", () => {
      expect(getRoundingError(100.00, 100.00)).toBe(0);
    });

    it("should return positive value when actual > expected", () => {
      expect(getRoundingError(100.00, 100.01)).toBeCloseTo(0.01, 10);
      expect(getRoundingError(100.00, 100.005)).toBeCloseTo(0.005, 10);
    });

    it("should return negative value when actual < expected", () => {
      expect(getRoundingError(100.00, 99.99)).toBeCloseTo(-0.01, 10);
      expect(getRoundingError(100.00, 99.995)).toBeCloseTo(-0.005, 10);
    });

    it("should handle large differences", () => {
      expect(getRoundingError(100.00, 110.00)).toBe(10.00);
      expect(getRoundingError(100.00, 50.00)).toBe(-50.00);
    });
  });

  describe("isRoundingError", () => {
    it("should return false when amounts are equal", () => {
      expect(isRoundingError(100.00, 100.00)).toBe(false);
    });

    it("should return true for small positive differences within tolerance", () => {
      expect(isRoundingError(100.00, 100.005)).toBe(true);
      expect(isRoundingError(100.00, 100.009)).toBe(true);
    });

    it("should return true for small negative differences within tolerance", () => {
      expect(isRoundingError(100.00, 99.995)).toBe(true);
      expect(isRoundingError(100.00, 99.991)).toBe(true);
    });

    it("should return true for exact tolerance boundary", () => {
      expect(isRoundingError(100.00, 100.01)).toBe(true);
      expect(isRoundingError(100.00, 99.99)).toBe(true);
    });

    it("should return false for differences exceeding tolerance", () => {
      expect(isRoundingError(100.00, 100.011)).toBe(false);
      expect(isRoundingError(100.00, 100.02)).toBe(false);
      expect(isRoundingError(100.00, 99.989)).toBe(false);
    });

    it("should support custom tolerance", () => {
      expect(isRoundingError(100.00, 100.05, 0.1)).toBe(true);
      expect(isRoundingError(100.00, 100.05, 0.01)).toBe(false);
    });
  });

  describe("roundToNearestCent", () => {
    it("should round up correctly", () => {
      expect(roundToNearestCent(100.005)).toBe(100.01);
      expect(roundToNearestCent(100.015)).toBe(100.02);
    });

    it("should round down correctly", () => {
      expect(roundToNearestCent(100.004)).toBe(100.00);
      expect(roundToNearestCent(100.014)).toBe(100.01);
    });

    it("should handle amounts with many decimal places", () => {
      expect(roundToNearestCent(100.12345)).toBe(100.12);
      expect(roundToNearestCent(100.99999)).toBe(101.00);
    });

    it("should handle whole numbers", () => {
      expect(roundToNearestCent(100)).toBe(100.00);
      expect(roundToNearestCent(100.00)).toBe(100.00);
    });

    it("should handle small amounts", () => {
      expect(roundToNearestCent(0.005)).toBe(0.01);
      expect(roundToNearestCent(0.004)).toBe(0.00);
    });

    it("should handle negative amounts", () => {
      expect(roundToNearestCent(-100.005)).toBeCloseTo(-100.01, 10);
      expect(roundToNearestCent(-100.004)).toBe(-100.00);
    });
  });

  describe("formatAmount", () => {
    it("should format with exactly 2 decimal places", () => {
      expect(formatAmount(100)).toBe("100.00");
      expect(formatAmount(100.5)).toBe("100.50");
      expect(formatAmount(100.05)).toBe("100.05");
    });

    it("should format small amounts", () => {
      expect(formatAmount(0.01)).toBe("0.01");
      expect(formatAmount(0.001)).toBe("0.00");
    });

    it("should format large amounts", () => {
      expect(formatAmount(1000000.05)).toBe("1000000.05");
    });

    it("should format negative amounts", () => {
      expect(formatAmount(-100.5)).toBe("-100.50");
    });

    it("should not truncate precision", () => {
      expect(formatAmount(100.126)).toBe("100.13");
    });
  });

  describe("isValidMonetaryAmount", () => {
    it("should return true for valid positive amounts", () => {
      expect(isValidMonetaryAmount(0)).toBe(true);
      expect(isValidMonetaryAmount(0.01)).toBe(true);
      expect(isValidMonetaryAmount(100)).toBe(true);
      expect(isValidMonetaryAmount(1000000.99)).toBe(true);
    });

    it("should return false for negative amounts", () => {
      expect(isValidMonetaryAmount(-0.01)).toBe(false);
      expect(isValidMonetaryAmount(-100)).toBe(false);
    });

    it("should return false for non-numeric values", () => {
      expect(isValidMonetaryAmount(NaN)).toBe(false);
      expect(isValidMonetaryAmount(Infinity)).toBe(false);
      expect(isValidMonetaryAmount(-Infinity)).toBe(false);
    });

    it("should return false for non-numbers", () => {
      expect(isValidMonetaryAmount("100" as any)).toBe(false);
      expect(isValidMonetaryAmount(null as any)).toBe(false);
      expect(isValidMonetaryAmount(undefined as any)).toBe(false);
    });
  });

  describe("Integration scenarios", () => {
    it("should correctly identify rounding error in account reconciliation", () => {
      const internalBalance = 1000.00;
      const externalBalance = 1000.01;

      expect(isRoundingError(externalBalance, internalBalance)).toBe(true);
      const error = getRoundingError(externalBalance, internalBalance);
      expect(error).toBeCloseTo(-0.01, 10);
      expect(formatAmount(error)).toBe("-0.01");
    });

    it("should correctly reject real discrepancies", () => {
      const internalBalance = 1000.00;
      const externalBalance = 1000.50;

      expect(isRoundingError(externalBalance, internalBalance)).toBe(false);
      expect(isWithinTolerance(internalBalance, externalBalance)).toBe(false);
    });

    it("should handle multiple rounding errors accumulation", () => {
      const amounts = [100.001, 100.002, 100.003, 100.004, 100.005];
      const total = amounts.reduce((sum, amt) => sum + amt, 0);

      // Note: accumulation of floating-point errors can result in unexpected totals
      // The formatted amount shows the practical accounting view
      expect(formatAmount(total)).toBe("500.01");
      // Shows that multiple small errors can compound
      expect(isWithinTolerance(500, total)).toBe(false);
    });
  });
});
