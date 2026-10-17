import { extractAmount, parseIndonesianNumber } from './amount.tokenizer';

describe('parseIndonesianNumber', () => {
  it.each([
    ['25000', 25000],
    ['25.000', 25000],
    ['1.500.000', 1_500_000],
    ['1,5', 1.5],
    ['25.000,50', 25000.5],
    ['1.5', 1.5],
    ['100', 100],
  ])('parses "%s" -> %d', (input, expected) => {
    expect(parseIndonesianNumber(input)).toBe(expected);
  });
});

describe('extractAmount', () => {
  const cases: Array<[string, number]> = [
    ['25rb', 25000],
    ['25 rb', 25000],
    ['25 ribu', 25000],
    ['25000', 25000],
    ['25.000', 25000],
    ['2 juta', 2_000_000],
    ['2jt', 2_000_000],
    ['100k', 100_000],
    ['1,5jt', 1_500_000],
    ['1.5jt', 1_500_000],
    ['Rp 25.000', 25000],
    ['rp25000', 25000],
    ['beli kopi 25rb', 25000],
    ['isi bensin 100rb', 100_000],
    ['gaji 8 juta', 8_000_000],
  ];

  it.each(cases)('extracts amount from "%s" -> %d', (text, expected) => {
    const match = extractAmount(text);
    expect(match).not.toBeNull();
    expect(match!.amount.toNumber()).toBe(expected);
  });

  it('returns null when no amount present', () => {
    expect(extractAmount('beli kopi')).toBeNull();
    expect(extractAmount('ringkasan bulan ini')).toBeNull();
  });

  it('does not read "25kg" as an amount with k-unit, nor as a price', () => {
    // "25kg" is a quantity: with no other number there is NO amount (the bot asks "berapa harganya?")
    expect(extractAmount('beras 25kg')).toBeNull();
  });

  // Regression: the first bare number used to win, so a quantity was recorded as the price.
  describe('quantities are not prices', () => {
    it.each([
      ['beli kopi 2 gelas 30000', 30000],
      ['beras 25kg 300000', 300000],
      ['beli 3 kopi 30000', 30000],
      ['makan 4 orang 200.000', 200000],
      ['susu 2 botol 45rb', 45000],
      ['pulsa 50000 bulan ini', 50000],
      ['bayar listrik 150000 hari ini', 150000],
      ['parkir 2 jam 4000', 4000],
      ['ongkir 500', 500],
    ])('reads "%s" as %d', (text, expected) => {
      expect(extractAmount(text)?.amount.toNumber()).toBe(expected);
    });

    it.each(['beli kopi 2 gelas', 'beras 25 kg', 'nonton 3 jam', 'makan 4 orang'])(
      'finds no price in "%s" (only a quantity)',
      (text) => expect(extractAmount(text)).toBeNull(),
    );
  });

  describe('comma as a thousands separator', () => {
    it.each([
      ['bayar 10,000', 10000],
      ['bayar 1,250,000', 1250000],
      ['beli 1,5jt', 1500000], // with a unit the comma stays a decimal
      ['bayar 2,50', 2.5], // two digits after a comma: still a decimal
    ])('reads "%s" as %d', (text, expected) => {
      expect(extractAmount(text)?.amount.toNumber()).toBe(expected);
    });
  });

  it('reports the matched span for stripping', () => {
    const match = extractAmount('beli kopi 25rb');
    expect(match).not.toBeNull();
    expect('beli kopi 25rb'.slice(match!.start, match!.end)).toBe('25rb');
  });
});
