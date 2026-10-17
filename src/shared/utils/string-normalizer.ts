/**
 * Text normalization helpers used by the rule-based parser (Phase 5) for
 * robust keyword matching regardless of casing, accents or extra whitespace.
 */

// Unicode range of combining diacritical marks (á -> a after NFKD).
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Lowercase, strip diacritics, collapse internal whitespace and trim.
 * e.g. "  Béli   KOPI " -> "beli kopi"
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize then split into word tokens (empty tokens removed). */
export function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/**
 * Remove common punctuation that is irrelevant to matching while keeping
 * digits, letters and separators the amount tokenizer relies on.
 */
export function stripPunctuation(input: string): string {
  return input
    .replace(/[!?"'`;:()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `haystack` contains `needle` as a whole normalized word. */
export function containsWord(haystack: string, needle: string): boolean {
  const tokens = tokenize(haystack);
  return tokens.includes(normalizeText(needle));
}
