/**
 * Property tests for money. Instead of a few hand-picked examples, thousands of generated cases per
 * property check the laws that exact arithmetic must obey. The generator is a seeded PRNG, so a failure is
 * reproducible: the seed and the offending input are in the failure message.
 *
 * (Hand-rolled on purpose: no extra dependency for a handful of properties.)
 */
import { extractAmount } from 'src/modules/parser/rule-based/amount.tokenizer';
import { MAX_AMOUNT_MINOR, Money } from './money';

/** mulberry32: small, fast, good enough, and deterministic. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20261016;
const CASES = 3_000;

/** A random bigint in [lo, hi] (inclusive), built from digits so it is exact beyond 2^53. */
function bigBetween(r: () => number, lo: bigint, hi: bigint): bigint {
  const span = hi - lo + 1n;
  let acc = 0n;
  for (let i = 0; i < 24; i += 1) acc = acc * 1000n + BigInt(Math.floor(r() * 1000));
  return lo + (acc % span);
}

const show = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));

/** Throws with the seed and input so a failing case can be replayed. */
function holds(condition: boolean, what: string, seed: number, input: unknown): void {
  if (!condition) throw new Error(`${what} (seed ${seed}, input ${show(input)})`);
}
function same<T>(actual: T, expected: T, what: string, seed: number, input: unknown): void {
  holds(
    actual === expected,
    `${what}: expected ${show(expected)}, got ${show(actual)}`,
    seed,
    input,
  );
}

describe('Money: laws of exact arithmetic', () => {
  it('addition is commutative and associative, and subtraction undoes it', () => {
    const r = rng(SEED);
    for (let i = 0; i < CASES; i += 1) {
      const [a, b, c] = [1, 2, 3].map(() =>
        Money.fromMinor(bigBetween(r, -MAX_AMOUNT_MINOR, MAX_AMOUNT_MINOR)),
      );
      const input = [a.minorUnits, b.minorUnits, c.minorUnits];
      holds(a.add(b).equals(b.add(a)), 'a+b != b+a', SEED, input);
      holds(
        a
          .add(b)
          .add(c)
          .equals(a.add(b.add(c))),
        '(a+b)+c != a+(b+c)',
        SEED,
        input,
      );
      holds(a.add(b).subtract(b).equals(a), '(a+b)-b != a', SEED, input);
      holds(a.subtract(a).isZero(), 'a-a != 0', SEED, input);
    }
  });

  it('a sum of many amounts is exactly the BigInt sum (no floating point anywhere)', () => {
    const r = rng(SEED + 1);
    for (let round = 0; round < 200; round += 1) {
      const parts = Array.from({ length: 1 + Math.floor(r() * 60) }, () =>
        bigBetween(r, 1n, 10n ** 13n),
      );
      const expected = parts.reduce((s, p) => s + p, 0n);
      const money = parts.reduce((s, p) => s.add(Money.fromMinor(p)), Money.zero());
      same(money.minorUnits, expected, 'sum differs', SEED + 1, parts);
    }
  });

  it('multiplying by an integer equals repeated addition', () => {
    const r = rng(SEED + 2);
    for (let i = 0; i < 1_000; i += 1) {
      const m = Money.fromMinor(bigBetween(r, 1n, 10n ** 12n));
      const k = 1 + Math.floor(r() * 50);
      let repeated = Money.zero();
      for (let j = 0; j < k; j += 1) repeated = repeated.add(m);
      holds(m.multiply(k).equals(repeated), 'multiply differs', SEED + 2, [m.minorUnits, k]);
    }
  });

  it('refuses a non-integer factor instead of rounding quietly', () => {
    expect(() => Money.fromMinor(100n).multiply(1.5)).toThrow();
    expect(() => Money.fromMinor(100n).multiply(Number.NaN)).toThrow();
  });
});

describe('Money: text round trips', () => {
  it('toDecimalString -> fromMajor is the identity for every amount', () => {
    const r = rng(SEED + 3);
    for (let i = 0; i < CASES; i += 1) {
      const m = Money.fromMinor(bigBetween(r, -MAX_AMOUNT_MINOR * 1000n, MAX_AMOUNT_MINOR * 1000n));
      same(
        Money.fromMajor(m.toDecimalString()).minorUnits,
        m.minorUnits,
        'round trip changed the amount',
        SEED + 3,
        m.minorUnits,
      );
    }
  });

  it('format() shows exactly the amount: digits and separators only, never exponent or NaN', () => {
    const r = rng(SEED + 4);
    for (let i = 0; i < CASES; i += 1) {
      const m = Money.fromMinor(bigBetween(r, -MAX_AMOUNT_MINOR, MAX_AMOUNT_MINOR));
      const text = m.format();
      holds(
        /^-?Rp\d{1,3}(\.\d{3})*(,\d{2})?$/.test(text),
        `unexpected display "${text}"`,
        SEED + 4,
        m.minorUnits,
      );
      // reading the display back gives the same amount
      const plain = text.replace('Rp', '').replace(/\./g, '').replace(',', '.');
      same(
        Money.fromMajor(plain).minorUnits,
        m.minorUnits,
        'display differs',
        SEED + 4,
        m.minorUnits,
      );
    }
  });

  it('an integer number of rupiah converts to exactly that many hundredths, up to the supported limit', () => {
    const r = rng(SEED + 5);
    for (let i = 0; i < CASES; i += 1) {
      const rupiah = Math.floor(r() * 1e13);
      same(
        Money.fromMajor(rupiah).minorUnits,
        BigInt(rupiah) * 100n,
        'conversion',
        SEED + 5,
        rupiah,
      );
    }
  });

  it('malformed text is rejected, never turned into a number', () => {
    const bad = [
      '',
      ' ',
      'abc',
      '1e5',
      '1,5',
      '1.2.3',
      '--1',
      '١٢٣',
      '1 000',
      '0x10',
      'Rp100',
      '1_000',
      '+5',
      '.5',
      '5.',
      'NaN',
      'Infinity',
      '1e999',
    ];
    for (const text of bad) {
      let accepted = false;
      try {
        Money.fromMajor(text);
        accepted = true;
      } catch {
        // rejected, as required
      }
      holds(!accepted, 'malformed text was accepted as money', 0, text);
    }
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => Money.fromMajor(n)).toThrow();
    }
  });

  it('keeps at most two decimals and never rounds an exact string', () => {
    expect(Money.fromMajor('0.999').toDecimalString()).toBe('0.99'); // truncated, documented behaviour
    expect(Money.fromMajor('10.50').minorUnits).toBe(1050n);
    expect(Money.fromMajor('-0.01').minorUnits).toBe(-1n);
  });
});

describe('Money: limits', () => {
  it('only amounts in (0, MAX] are within the per-record limit', () => {
    const r = rng(SEED + 6);
    for (let i = 0; i < CASES; i += 1) {
      const minor = bigBetween(r, -MAX_AMOUNT_MINOR * 2n, MAX_AMOUNT_MINOR * 2n);
      same(
        Money.fromMinor(minor).isWithinLimit(),
        minor > 0n && minor <= MAX_AMOUNT_MINOR,
        'limit',
        SEED + 6,
        minor,
      );
    }
    expect(Money.fromMinor(MAX_AMOUNT_MINOR).isWithinLimit()).toBe(true);
    expect(Money.fromMinor(MAX_AMOUNT_MINOR + 1n).isWithinLimit()).toBe(false);
    expect(Money.fromMinor(0n).isWithinLimit()).toBe(false);
    expect(Money.fromMinor(-1n).isWithinLimit()).toBe(false);
  });
});

describe('amount parsing from chat text', () => {
  const UNITS: Array<[string, number]> = [
    ['rb', 1_000],
    ['ribu', 1_000],
    ['k', 1_000],
    ['jt', 1_000_000],
    ['juta', 1_000_000],
  ];

  it('"<n><unit>" is always exactly n x unit rupiah, for any whole n', () => {
    const r = rng(SEED + 7);
    for (let i = 0; i < CASES; i += 1) {
      const n = 1 + Math.floor(r() * 99_999);
      const [unit, multiplier] = UNITS[Math.floor(r() * UNITS.length)];
      const spaced = r() < 0.3 ? ' ' : '';
      const match = extractAmount(`beli sesuatu ${n}${spaced}${unit}`);
      holds(match !== null, 'no amount found', SEED + 7, [n, unit]);
      same(
        match!.amount.minorUnits,
        BigInt(n) * BigInt(multiplier) * 100n,
        'wrong amount',
        SEED + 7,
        [n, unit],
      );
    }
  });

  it('a plain Indonesian number with dot thousands separators parses to that number', () => {
    const r = rng(SEED + 8);
    for (let i = 0; i < CASES; i += 1) {
      const n = 1_000 + Math.floor(r() * 99_000_000);
      const text = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      const match = extractAmount(`bayar ${text}`);
      holds(match !== null, 'no amount found', SEED + 8, text);
      same(match!.amount.minorUnits, BigInt(n) * 100n, 'wrong amount', SEED + 8, text);
    }
  });

  it('never throws and never returns a negative amount, whatever the text', () => {
    const r = rng(SEED + 9);
    const alphabet = '0123456789.,- rbjtkuxnA‮\u0000e+';
    for (let i = 0; i < CASES; i += 1) {
      const text = Array.from(
        { length: Math.floor(r() * 40) },
        () => alphabet[Math.floor(r() * alphabet.length)],
      ).join('');
      let result: ReturnType<typeof extractAmount> = null;
      try {
        result = extractAmount(text);
      } catch (err) {
        throw new Error(`threw on ${show(text)} (seed ${SEED + 9}): ${String(err)}`);
      }
      if (result) holds(result.amount.minorUnits >= 0n, 'negative amount', SEED + 9, text);
    }
  });

  it('stays fast on adversarial input (no catastrophic backtracking)', () => {
    const nasty = [
      '1' + '.'.repeat(5_000),
      '9'.repeat(5_000) + 'rb',
      '1,'.repeat(3_000),
      ' '.repeat(5_000) + '5rb',
      '1.'.repeat(3_000) + 'juta',
    ];
    for (const text of nasty) {
      const started = performance.now();
      extractAmount(text);
      const took = performance.now() - started;
      holds(
        took < 250,
        `took ${Math.round(took)} ms on an input of ${text.length} characters`,
        0,
        text.slice(0, 20),
      );
    }
  });
});
