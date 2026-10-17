/**
 * Money value object.
 *
 * Amounts are stored internally as an integer number of **minor units** (cents)
 * in a `bigint`, so arithmetic is exact — no floating-point drift (NFR-9).
 * {@link Money.toDecimalString} gives an exact 2-decimal representation.
 *
 * IDR conventionally has no sub-unit, but we keep 2 decimals for a consistent,
 * currency-agnostic model.
 */
const MINOR_UNIT_SCALE = 100n;

/**
 * Largest amount a single record may hold: 10^15 minor units = 10^13 rupiah (Rp10 triliun). The
 * database enforces the same bound with a CHECK constraint, and 10^15 keeps any realistic sum far
 * inside BIGINT (9.2 x 10^18).
 */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000_000n;

export class Money {
  private constructor(private readonly minor: bigint) {}

  // ---- Factories ----

  static fromMinor(minorUnits: bigint | number): Money {
    return new Money(typeof minorUnits === 'bigint' ? minorUnits : BigInt(Math.trunc(minorUnits)));
  }

  /** Build from a major-unit amount (e.g. rupiah). Accepts number or numeric string. */
  static fromMajor(amount: number | string): Money {
    if (typeof amount === 'number') {
      if (!Number.isFinite(amount)) {
        throw new Error(`Invalid money amount: ${amount}`);
      }
      return new Money(BigInt(Math.round(amount * 100)));
    }

    const trimmed = amount.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`Invalid money string: "${amount}"`);
    }
    const negative = trimmed.startsWith('-');
    const [intPart, fracPart = ''] = trimmed.replace('-', '').split('.');
    const cents = BigInt(intPart) * MINOR_UNIT_SCALE + BigInt((fracPart + '00').slice(0, 2));
    return new Money(negative ? -cents : cents);
  }

  static zero(): Money {
    return new Money(0n);
  }

  // ---- Accessors ----

  get minorUnits(): bigint {
    return this.minor;
  }

  /** Major-unit amount as a JS number. Safe for display; avoid for further math. */
  toNumber(): number {
    return Number(this.minor) / 100;
  }

  /** "25000.00" — exact decimal string (2 fraction digits). */
  toDecimalString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const major = abs / MINOR_UNIT_SCALE;
    const minor = abs % MINOR_UNIT_SCALE;
    return `${negative ? '-' : ''}${major.toString()}.${minor.toString().padStart(2, '0')}`;
  }

  // ---- Arithmetic (immutable) ----

  add(other: Money): Money {
    return new Money(this.minor + other.minor);
  }

  subtract(other: Money): Money {
    return new Money(this.minor - other.minor);
  }

  /** Multiply by an integer factor (e.g. quantity). */
  multiply(factor: number): Money {
    if (!Number.isInteger(factor)) {
      throw new Error('Money.multiply expects an integer factor');
    }
    return new Money(this.minor * BigInt(factor));
  }

  // ---- Predicates ----

  /** True when the amount is within the supported per-record range (positive and not too big). */
  isWithinLimit(): boolean {
    return this.minor > 0n && this.minor <= MAX_AMOUNT_MINOR;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }
  isNegative(): boolean {
    return this.minor < 0n;
  }
  isPositive(): boolean {
    return this.minor > 0n;
  }
  equals(other: Money): boolean {
    return this.minor === other.minor;
  }
  /** -1 if this < other, 0 if equal, 1 if this > other. */
  compareTo(other: Money): number {
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  // ---- Formatting ----

  /**
   * Indonesian Rupiah display, e.g. `Rp25.000`, `-Rp1.500`.
   * Sub-units are shown only when non-zero: `Rp25.000,50`.
   */
  format(currencySymbol = 'Rp'): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const major = abs / MINOR_UNIT_SCALE;
    const minor = abs % MINOR_UNIT_SCALE;

    const grouped = major.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

    const fraction = minor === 0n ? '' : `,${minor.toString().padStart(2, '0')}`;
    return `${negative ? '-' : ''}${currencySymbol}${grouped}${fraction}`;
  }

  toString(): string {
    return this.format();
  }
}
