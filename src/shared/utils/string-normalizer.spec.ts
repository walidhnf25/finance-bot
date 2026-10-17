import { containsWord, normalizeText, stripPunctuation, tokenize } from './string-normalizer';

describe('string-normalizer', () => {
  describe('normalizeText', () => {
    it('lowercases, trims and collapses whitespace', () => {
      expect(normalizeText('  Beli   KOPI ')).toBe('beli kopi');
    });

    it('strips diacritics', () => {
      expect(normalizeText('Café')).toBe('cafe');
    });

    it('returns empty string for whitespace-only input', () => {
      expect(normalizeText('   ')).toBe('');
    });
  });

  describe('tokenize', () => {
    it('splits into normalized tokens', () => {
      expect(tokenize('Beli Kopi Susu')).toEqual(['beli', 'kopi', 'susu']);
    });

    it('returns empty array for empty input', () => {
      expect(tokenize('   ')).toEqual([]);
    });
  });

  describe('stripPunctuation', () => {
    it('removes punctuation but keeps digits and letters', () => {
      expect(stripPunctuation('beli kopi (25rb)!')).toBe('beli kopi 25rb');
    });
  });

  describe('containsWord', () => {
    it('matches a whole word regardless of case', () => {
      expect(containsWord('Beli Kopi pagi', 'kopi')).toBe(true);
    });

    it('does not match partial words', () => {
      expect(containsWord('kopiku enak', 'kopi')).toBe(false);
    });
  });
});
