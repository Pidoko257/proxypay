import { roundHalfEven, bankersRound, roundCurrencyBankers } from '../bankersRounding';
import { CurrencyFormatter } from '../CurrencyFormatter';

describe("Banker's Rounding (Round Half to Even) - Issue #681", () => {
  describe('roundHalfEven & bankersRound base logic', () => {
    it('rounds halfway numbers to the nearest even integer (decimals = 0)', () => {
      expect(roundHalfEven(0.5)).toBe(0);
      expect(roundHalfEven(1.5)).toBe(2);
      expect(roundHalfEven(2.5)).toBe(2);
      expect(roundHalfEven(3.5)).toBe(4);
      expect(roundHalfEven(4.5)).toBe(4);
      expect(roundHalfEven(5.5)).toBe(6);
    });

    it('correctly rounds negative halfway numbers to nearest even integer', () => {
      expect(roundHalfEven(-0.5)).toBe(-0);
      expect(roundHalfEven(-1.5)).toBe(-2);
      expect(roundHalfEven(-2.5)).toBe(-2);
      expect(roundHalfEven(-3.5)).toBe(-4);
      expect(roundHalfEven(-4.5)).toBe(-4);
    });

    it('rounds non-halfway numbers normally', () => {
      expect(roundHalfEven(1.4)).toBe(1);
      expect(roundHalfEven(1.6)).toBe(2);
      expect(roundHalfEven(2.4)).toBe(2);
      expect(roundHalfEven(2.6)).toBe(3);
    });

    it('handles 2 decimal places with half-even tie breaking', () => {
      expect(roundHalfEven(1.245, 2)).toBe(1.24); // 4 is even
      expect(roundHalfEven(1.255, 2)).toBe(1.26); // 5 rounds to 6 (even)
      expect(roundHalfEven(1.265, 2)).toBe(1.26); // 6 is even
      expect(roundHalfEven(1.275, 2)).toBe(1.28); // 7 rounds to 8 (even)
      expect(roundHalfEven(2.005, 2)).toBe(2.00); // 0 is even
      expect(roundHalfEven(2.015, 2)).toBe(2.02); // 1 rounds to 2 (even)
    });

    it('handles non-halfway 2 decimal cases without rounding drift', () => {
      expect(roundHalfEven(1.244, 2)).toBe(1.24);
      expect(roundHalfEven(1.246, 2)).toBe(1.25);
      expect(roundHalfEven(1.254, 2)).toBe(1.25);
      expect(roundHalfEven(1.256, 2)).toBe(1.26);
    });

    it('bankersRound alias produces identical results to roundHalfEven', () => {
      expect(bankersRound(2.5)).toBe(roundHalfEven(2.5));
      expect(bankersRound(3.5)).toBe(roundHalfEven(3.5));
      expect(bankersRound(1.245, 2)).toBe(roundHalfEven(1.245, 2));
      expect(bankersRound(1.255, 2)).toBe(roundHalfEven(1.255, 2));
    });
  });

  describe('roundCurrencyBankers', () => {
    it('rounds XAF to 0 decimal places using half-even', () => {
      expect(roundCurrencyBankers(5000.5, 'XAF')).toBe(5000); // 0 is even
      expect(roundCurrencyBankers(5001.5, 'XAF')).toBe(5002); // 1 rounds to 2 (even)
      expect(roundCurrencyBankers(5000.4, 'XAF')).toBe(5000);
      expect(roundCurrencyBankers(5000.6, 'XAF')).toBe(5001);
    });

    it('rounds USD, GHS, and NGN to 2 decimal places using half-even', () => {
      expect(roundCurrencyBankers(10.245, 'USD')).toBe(10.24);
      expect(roundCurrencyBankers(10.255, 'USD')).toBe(10.26);

      expect(roundCurrencyBankers(99.005, 'GHS')).toBe(99.00);
      expect(roundCurrencyBankers(99.015, 'GHS')).toBe(99.02);

      expect(roundCurrencyBankers(500.245, 'NGN')).toBe(500.24);
      expect(roundCurrencyBankers(500.255, 'NGN')).toBe(500.26);
    });
  });

  describe('CurrencyFormatter integration', () => {
    it('CurrencyFormatter.roundBankers delegates to roundHalfEven', () => {
      expect(CurrencyFormatter.roundBankers(1.245, 2)).toBe(1.24);
      expect(CurrencyFormatter.roundBankers(1.255, 2)).toBe(1.26);
    });

    it('CurrencyFormatter.roundAmountBankers applies currency precision', () => {
      expect(CurrencyFormatter.roundAmountBankers(1234.5, 'XAF')).toBe(1234);
      expect(CurrencyFormatter.roundAmountBankers(1.245, 'USD')).toBe(1.24);
    });

    it('supports roundingMode: "half-even" in format() options', () => {
      const formattedEven = CurrencyFormatter.format(1.245, 'USD', { roundingMode: 'half-even' });
      expect(formattedEven).toContain('1.24');

      const formattedOdd = CurrencyFormatter.format(1.255, 'USD', { roundingMode: 'half-even' });
      expect(formattedOdd).toContain('1.26');
    });

    it('supports roundingMode: "bankers" in format() options', () => {
      const formattedEven = CurrencyFormatter.format(1.245, 'USD', { roundingMode: 'bankers' });
      expect(formattedEven).toContain('1.24');

      const formattedOdd = CurrencyFormatter.format(1.255, 'USD', { roundingMode: 'bankers' });
      expect(formattedOdd).toContain('1.26');
    });
  });

  describe('Reconciliation consistency & bias prevention', () => {
    it('eliminates upward statistical bias compared to Math.round across balanced ties', () => {
      // Set of values with identical .5 ties: 0.5, 1.5, 2.5, 3.5, 4.5, 5.5
      // Exact sum: 0.5 + 1.5 + 2.5 + 3.5 + 4.5 + 5.5 = 18
      const values = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];

      const mathRoundSum = values.reduce((sum, v) => sum + Math.round(v), 0);
      // Math.round: 1 + 2 + 3 + 4 + 5 + 6 = 21 (biased upward by +3)
      expect(mathRoundSum).toBe(21);

      const bankersSum = values.reduce((sum, v) => sum + roundHalfEven(v), 0);
      // Bankers: 0 + 2 + 2 + 4 + 4 + 6 = 18 (exact preservation of total!)
      expect(bankersSum).toBe(18);
    });
  });
});