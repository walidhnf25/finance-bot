import { Wallet } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';

/**
 * What the pipeline believes a receipt says. It is only ever a PROPOSAL: nothing is stored as a
 * transaction until the user confirms it. Amounts are whole rupiah.
 */
export interface ReceiptExtraction {
  merchant: string | null;
  /** Calendar date printed on the receipt, `YYYY-MM-DD`, or null when unreadable. */
  date: string | null;
  /** Grand total in whole rupiah. */
  total: number;
  items: ReceiptItem[];
  /** Category hint in the user's own vocabulary (feeds the existing keyword categorizer). */
  categoryHint: string | null;
  /** Wallet chosen by the user in a correction ("dompet digital"); never inferred by the AI. */
  wallet: Wallet | null;
  /** Machine-readable problems the user should look at before confirming. */
  warnings: ReceiptWarning[];
}

export interface ReceiptItem {
  name: string;
  /** Line total in whole rupiah. */
  amount: number;
}

export type ReceiptWarning =
  | 'TOTAL_NOT_IN_TEXT' // the total does not appear among the numbers read from the image
  | 'ITEMS_DO_NOT_ADD_UP' // line items disagree with the total
  | 'TOTAL_DERIVED' // no labelled total: it was worked out as paid minus change
  | 'TOTAL_CONFLICTS_WITH_PAYMENT' // the total disagrees with the paid/change lines
  | 'TOTAL_DISPUTED' // the model and the printed total line disagree; the printed line was used
  | 'TOTAL_UNLABELLED' // the text has no total line: the model picked a number, so check it
  | 'TOTAL_AMBIGUOUS' // two lines of the same kind state different totals; the last one was used
  | 'DATE_MISSING'
  | 'DATE_ADJUSTED' // the printed date was in the future; today is used instead
  | 'DATE_OLD' // the printed date is more than ~3 years ago: kept, but worth a look
  | 'POSSIBLE_DUPLICATE' // an expense with the same amount on the same day is already recorded
  | 'MERCHANT_MISSING';

export class InvalidExtractionError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid receipt extraction: ${reason}`);
    this.name = 'InvalidExtractionError';
  }
}

export const MAX_MERCHANT_LENGTH = 80;
export const MAX_ITEM_NAME_LENGTH = 80;
export const MAX_ITEMS = 50;
/** Receipts older than this are treated as misread dates. */
const MAX_AGE_DAYS = 365 * 3;
/** Allowed rounding noise between the sum of the lines and the printed total (tax, service...). */
const ITEMS_TOLERANCE_RATIO = 0.25;

// Built from escaped ranges (not a regex literal): C0/C1 controls, zero-width marks and bidi overrides.
/* eslint-disable no-control-regex */
const CONTROL_CHARS = new RegExp(
  '[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]',
  'g',
);
/* eslint-enable no-control-regex */

/** Text that came from a photo is data: strip control/bidi characters, collapse whitespace, cap length. */
export function sanitizeText(value: string, maxLength: number): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accepts `15000`, `15000.0` and `"15.000"`/`"Rp 15,000"` style strings; rejects everything else. */
export function toRupiah(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : Number.isFinite(value) ? Math.round(value) : null;
  }
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/rp\.?/gi, '').replace(/\s/g, '');
  // "15.000,50" / "15,000.00" / "15000,00": a two-digit tail after the last separator is cents, not
  // part of the number. (Stripping every separator blindly read "15.000,50" as 1.500.050.)
  const cents = /^(\d{1,3}(?:[.,]\d{3})+|\d{4,})[.,]\d{2}$/.exec(cleaned);
  const digits = (cents ? cents[1] : cleaned).replace(/[.,]/g, '');
  if (!/^\d{1,16}$/.test(digits)) return null;
  return Number(digits);
}

const todayKey = (now: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

function isRealDate(key: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export interface ValidationContext {
  now: Date;
  timezone: string;
  /** Text read from the image; the total must be traceable to it. */
  sourceText: string;
}

/** All amounts (as whole numbers) that appear in the OCR text, tolerant of `.`/`,` separators. */
export function numbersInText(text: string): Set<number> {
  const found = new Set<number>();
  for (const token of text.match(/\d[\d.,]*\d|\d/g) ?? []) {
    const digitsOnly = token.replace(/[.,]/g, '');
    if (/^\d{1,16}$/.test(digitsOnly)) found.add(Number(digitsOnly));
    // "15.000,00" style: ignore a trailing 2-digit decimal part.
    const withoutDecimals = token.replace(/[.,]\d{2}$/, '').replace(/[.,]/g, '');
    if (/^\d{1,16}$/.test(withoutDecimals)) found.add(Number(withoutDecimals));
  }
  return found;
}

/**
 * Strictly validates untrusted model output (or a user correction) into a {@link ReceiptExtraction}.
 * Unknown properties are ignored (never copied), types are checked, and every money rule is applied
 * here in code, never delegated to the model. Throws {@link InvalidExtractionError}.
 */
export function validateExtraction(raw: unknown, ctx: ValidationContext): ReceiptExtraction {
  if (!isRecord(raw)) throw new InvalidExtractionError('not an object');

  const total = toRupiah(raw.total);
  if (total === null || total <= 0)
    throw new InvalidExtractionError('total is missing or not positive');
  if (!Money.fromMajor(total).isWithinLimit())
    throw new InvalidExtractionError('total is too large');

  const warnings: ReceiptWarning[] = [];

  const merchantRaw =
    typeof raw.merchant === 'string' ? sanitizeText(raw.merchant, MAX_MERCHANT_LENGTH) : '';
  const merchant = merchantRaw.length > 0 ? merchantRaw : null;
  if (!merchant) warnings.push('MERCHANT_MISSING');

  let date: string | null = null;
  if (typeof raw.date === 'string' && isRealDate(raw.date.trim())) {
    const candidate = raw.date.trim();
    const today = todayKey(ctx.now, ctx.timezone);
    const oldest = todayKey(new Date(ctx.now.getTime() - MAX_AGE_DAYS * 86_400_000), ctx.timezone);
    // ISO date strings compare correctly as text. One day of slack covers time zones.
    const tomorrow = todayKey(new Date(ctx.now.getTime() + 86_400_000), ctx.timezone);
    if (candidate > tomorrow) {
      // A receipt cannot be from the future: almost certainly a misread.
      date = today;
      warnings.push('DATE_ADJUSTED');
    } else {
      // An old receipt can be genuine, so the printed date is kept, but the user is told.
      date = candidate;
      if (candidate < oldest) warnings.push('DATE_OLD');
    }
  } else {
    warnings.push('DATE_MISSING');
  }

  const items: ReceiptItem[] = [];
  if (Array.isArray(raw.items)) {
    for (const entry of raw.items.slice(0, MAX_ITEMS)) {
      if (!isRecord(entry) || typeof entry.name !== 'string') continue;
      const amount = toRupiah(entry.amount);
      const name = sanitizeText(entry.name, MAX_ITEM_NAME_LENGTH);
      if (amount === null || amount <= 0 || name.length === 0) continue;
      items.push({ name, amount });
    }
  }
  if (items.length > 0) {
    const sum = items.reduce((acc, i) => acc + i.amount, 0);
    if (Math.abs(sum - total) > total * ITEMS_TOLERANCE_RATIO) warnings.push('ITEMS_DO_NOT_ADD_UP');
  }

  if (ctx.sourceText && !numbersInText(ctx.sourceText).has(total))
    warnings.push('TOTAL_NOT_IN_TEXT');

  const categoryHint =
    typeof raw.categoryHint === 'string' && raw.categoryHint.trim()
      ? sanitizeText(raw.categoryHint, 40).toLowerCase()
      : null;

  return {
    merchant,
    date,
    total,
    items,
    categoryHint,
    wallet: raw.wallet === Wallet.CASH || raw.wallet === Wallet.DIGITAL ? raw.wallet : null,
    warnings,
  };
}

/** Re-reads a stored extraction (JSON column) without re-running source-text checks. */
export function reviveExtraction(stored: unknown, now: Date, timezone: string): ReceiptExtraction {
  const revived = validateExtraction(stored, { now, timezone, sourceText: '' });
  const original = isRecord(stored) && Array.isArray(stored.warnings) ? stored.warnings : [];
  const keep = original.filter(
    (w): w is ReceiptWarning =>
      w === 'TOTAL_NOT_IN_TEXT' ||
      w === 'ITEMS_DO_NOT_ADD_UP' ||
      w === 'TOTAL_DERIVED' ||
      w === 'TOTAL_CONFLICTS_WITH_PAYMENT' ||
      w === 'TOTAL_DISPUTED' ||
      w === 'TOTAL_UNLABELLED' ||
      w === 'TOTAL_AMBIGUOUS' ||
      w === 'POSSIBLE_DUPLICATE',
  );
  return {
    ...revived,
    warnings: [...new Set([...revived.warnings, ...keep])],
  };
}
