import { MAX_AMOUNT_MINOR, Money } from './money';

describe('Money', () => {
  describe('factories', () => {
    it('creates from major units (number)', () => {
      expect(Money.fromMajor(25000).minorUnits).toBe(2_500_000n);
    });

    it('creates from major units (string with decimals)', () => {
      expect(Money.fromMajor('25000.50').minorUnits).toBe(2_500_050n);
    });

    it('creates from minor units', () => {
      expect(Money.fromMinor(2_500_000n).toNumber()).toBe(25000);
    });

    it('rounds float major amounts to nearest cent', () => {
      expect(Money.fromMajor(0.1 + 0.2).toDecimalString()).toBe('0.30');
    });

    it('rejects invalid strings', () => {
      expect(() => Money.fromMajor('abc')).toThrow();
      expect(() => Money.fromMajor('12.3.4')).toThrow();
    });

    it('rejects non-finite numbers', () => {
      expect(() => Money.fromMajor(Infinity)).toThrow();
    });
  });

  describe('arithmetic is exact', () => {
    it('adds without float drift', () => {
      const total = Money.fromMajor(0.1).add(Money.fromMajor(0.2));
      expect(total.toDecimalString()).toBe('0.30');
    });

    it('subtracts', () => {
      expect(Money.fromMajor(8_000_000).subtract(Money.fromMajor(3_250_000)).toNumber()).toBe(
        4_750_000,
      );
    });

    it('multiplies by integer factor', () => {
      expect(Money.fromMajor(2500).multiply(3).toNumber()).toBe(7500);
    });

    it('throws on non-integer factor', () => {
      expect(() => Money.fromMajor(100).multiply(1.5)).toThrow();
    });
  });

  describe('predicates', () => {
    it('detects zero / sign', () => {
      expect(Money.zero().isZero()).toBe(true);
      expect(Money.fromMajor(-1).isNegative()).toBe(true);
      expect(Money.fromMajor(1).isPositive()).toBe(true);
    });

    it('compares and equals', () => {
      expect(Money.fromMajor(100).compareTo(Money.fromMajor(200))).toBe(-1);
      expect(Money.fromMajor(200).compareTo(Money.fromMajor(100))).toBe(1);
      expect(Money.fromMajor(100).equals(Money.fromMajor(100))).toBe(true);
    });
  });

  describe('decimal string', () => {
    it('formats whole amounts with .00', () => {
      expect(Money.fromMajor(25000).toDecimalString()).toBe('25000.00');
    });
    it('handles negatives', () => {
      expect(Money.fromMajor(-1500).toDecimalString()).toBe('-1500.00');
    });
  });

  describe('format (Rupiah)', () => {
    it('groups thousands with dots', () => {
      expect(Money.fromMajor(25000).format()).toBe('Rp25.000');
      expect(Money.fromMajor(8_000_000).format()).toBe('Rp8.000.000');
    });
    it('shows sub-units only when non-zero', () => {
      expect(Money.fromMajor('1500.50').format()).toBe('Rp1.500,50');
    });
    it('prefixes negatives', () => {
      expect(Money.fromMajor(-1500).format()).toBe('-Rp1.500');
    });
  });

  describe('isWithinLimit (what the database CHECK constraint also enforces)', () => {
    it('accepts positive amounts up to the maximum, exactly', () => {
      expect(Money.fromMinor(1n).isWithinLimit()).toBe(true);
      expect(Money.fromMinor(MAX_AMOUNT_MINOR).isWithinLimit()).toBe(true);
    });
    it('rejects zero, negatives and anything above the maximum', () => {
      expect(Money.zero().isWithinLimit()).toBe(false);
      expect(Money.fromMajor(-5).isWithinLimit()).toBe(false);
      expect(Money.fromMinor(MAX_AMOUNT_MINOR + 1n).isWithinLimit()).toBe(false);
      expect(Money.fromMajor('99999999999999999999').isWithinLimit()).toBe(false);
    });
  });
});
