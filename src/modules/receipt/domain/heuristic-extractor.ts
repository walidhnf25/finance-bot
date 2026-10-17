import { ReceiptWarning } from './receipt-extraction';

/**
 * Deterministic reading of OCR text. It is used when no model is available or the model's
 * answer is invalid, and it also double-checks the model. It is deliberately conservative: it only
 * returns a total when the text itself labels one (or when "paid minus change" proves it), and it
 * never picks "the biggest number at the bottom".
 */
export interface HeuristicResult {
  merchant: string | null;
  date: string | null;
  total: number | null;
  /** Problems the parser itself noticed; they are merged into the draft's warnings. */
  warnings: ReceiptWarning[];
}

/** A receipt total below this is a misread (quantities, item counts, percentages). */
const MIN_TOTAL = 100;

// ---- amounts -----------------------------------------------------------------------------------

/**
 * One amount token to whole rupiah. Indonesian style (`.` thousands, `,` decimals), English style
 * (`,` thousands, `.` decimals) and plain digits are all recognised; the decimals of `30.500,00`
 * are dropped instead of being glued to the integer part.
 */
export function parseAmountToken(raw: string): number | null {
  const t = raw
    .replace(/^(rp\.?|idr)\s*/i, '')
    .replace(/[,.]-+$/, '')
    .replace(/\s+/g, '');
  let integer: string | null = null;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t))
    integer = t.replace(/,\d{1,2}$/, '').replace(/\./g, '');
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t))
    integer = t.replace(/\.\d{1,2}$/, '').replace(/,/g, '');
  else if (/^\d+(,\d{1,2})$/.test(t)) integer = t.replace(/,\d{1,2}$/, '');
  else if (/^\d+\.\d{1,2}$/.test(t)) integer = t.replace(/\.\d{1,2}$/, '');
  else if (/^\d+$/.test(t)) integer = t;
  if (integer === null || integer.length > 15) return null;
  return Number(integer);
}

const AMOUNT_TOKEN =
  /(?<![\d.,-])(?:rp\.?\s*|idr\s*)?\d[\d.,]*\d(?:\s?,-)?|(?<![\d.,-])(?:rp\.?\s*|idr\s*)?\d(?![\d.,])/gi;

/** Every non-negative amount on a line, left to right. A "-5.000" discount is skipped. */
export function amountsOnLine(line: string): number[] {
  const found: number[] = [];
  for (const m of line.matchAll(AMOUNT_TOKEN)) {
    const value = parseAmountToken(m[0].trim());
    if (value !== null) found.push(value);
  }
  return found;
}

// ---- labels ------------------------------------------------------------------------------------

/**
 * "total" as OCR tends to read it: T0TAL, T0TA1, ToTar, TOTAI ... (o/0, a/4, and l/1/i/I/r at the end).
 * Only the word TOTAL gets this tolerance; it is what every other label hangs on.
 */
const TOT = 't[o0]t[a4][l1i|r]';

/** Lines that state the amount to pay. */
const FINAL_LABEL = new RegExp(
  String.raw`(grand\s*${TOT}|${TOT}\s*(bayar|belanja|tagihan|akhir|harga|pembayaran|transaksi)|netto|net\s*${TOT}|jumlah\s*(bayar|tagihan|akhir)|amount\s*due|balance\s*due|harus\s*dibayar|${TOT}\s*due)`,
  'i',
);
/** A plain "total" / "jumlah". */
const PLAIN_LABEL = new RegExp(`(?<![a-z])(${TOT}|jumlah)(?![a-z])`, 'i');
/** "Total ..." lines that are NOT the amount to pay. */
const NOT_THE_TOTAL = new RegExp(
  String.raw`(sub\s*-?\s*${TOT}|${TOT}\s*(item|items|qty|pcs|barang|produk|pajak|tax|ppn|service|servis|diskon|disc|hemat|potongan|point|poin)|jumlah\s*(item|qty|barang|pcs))`,
  'i',
);
const TENDER_LABEL =
  /(?<![a-z])(tunai|cash|dibayar|bayar|debit|kredit|kartu|card|qris|e-?money|transfer|gopay|ovo|dana|shopeepay|tendered|payment)(?![a-z])/i;
const CHANGE_LABEL = /(?<![a-z])(kembali|kembalian|change|kmbl)(?![a-z])/i;

type Kind = 'final' | 'plain';

function classify(line: string): Kind | null {
  if (NOT_THE_TOTAL.test(line)) return null;
  if (FINAL_LABEL.test(line)) return 'final';
  if (PLAIN_LABEL.test(line))
    return TENDER_LABEL.test(line.replace(PLAIN_LABEL, '')) ? null : 'plain';
  return null;
}

/** The amount belonging to a labelled line: its last amount, else the next line's (label alone). */
function amountFor(lines: string[], index: number): number | null {
  const own = amountsOnLine(lines[index]).filter((n) => n >= MIN_TOTAL);
  if (own.length > 0) return own[own.length - 1];
  for (let k = index + 1; k <= Math.min(index + 2, lines.length - 1); k++) {
    if (classify(lines[k]) || TENDER_LABEL.test(lines[k]) || CHANGE_LABEL.test(lines[k])) break;
    const next = amountsOnLine(lines[k]).filter((n) => n >= MIN_TOTAL);
    if (next.length > 0) return next[next.length - 1];
  }
  return null;
}

// ---- date and merchant ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1,
  januari: 1,
  january: 1,
  feb: 2,
  februari: 2,
  february: 2,
  pebruari: 2,
  mar: 3,
  maret: 3,
  march: 3,
  apr: 4,
  april: 4,
  mei: 5,
  may: 5,
  jun: 6,
  juni: 6,
  june: 6,
  jul: 7,
  juli: 7,
  july: 7,
  agu: 8,
  agt: 8,
  agus: 8,
  agustus: 8,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  okt: 10,
  oct: 10,
  oktober: 10,
  october: 10,
  nov: 11,
  november: 11,
  nopember: 11,
  des: 12,
  dec: 12,
  desember: 12,
  december: 12,
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** Calendar-valid `YYYY-MM-DD`, or null. A 2-digit year means 20yy. */
function ymd(year: number, month: number, day: number): string | null {
  const y = year < 100 ? 2000 + year : year;
  if (y < 2000 || y > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(y, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${y}-${pad(month)}-${pad(day)}`;
}

/**
 * OCR often reads digits as look-alike letters (O/o -> 0, l/I/i/| -> 1, S -> 5, B -> 8). Only the
 * characters inside a date-shaped token are repaired, so ordinary words are left alone.
 */
function repairDigits(token: string): string {
  return token
    .replace(/[Oo]/g, '0')
    .replace(/[lIi|]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8');
}

const DIGITISH = '[0-9OoIl|iSB]';

/**
 * Finds the printed date. Understands dd/mm/yyyy, dd-mm-yy, dd.mm.yyyy (also with spaces around the
 * separators), yyyy-mm-dd, and "12 Okt 2026" / "12-Oktober-26" / "Oct 12, 2026" style dates,
 * including common OCR digit confusions. Day first, as is usual in Indonesia. The first valid
 * date in the text wins.
 */
export function findDate(text: string): string | null {
  const numeric = new RegExp(
    `(?<![0-9A-Za-z])(${DIGITISH}{1,4})\\s?[-/.]\\s?(${DIGITISH}{1,2})\\s?[-/.]\\s?(${DIGITISH}{2,4})(?![0-9A-Za-z])`,
    'g',
  );
  for (const m of text.matchAll(numeric)) {
    const [a, b, c] = [repairDigits(m[1]), repairDigits(m[2]), repairDigits(m[3])];
    if (![a, b, c].every((part) => /^\d+$/.test(part))) continue;
    const found =
      a.length === 4 ? ymd(Number(a), Number(b), Number(c)) : ymd(Number(c), Number(b), Number(a));
    if (found) return found;
  }

  const names = Object.keys(MONTHS)
    .sort((x, y) => y.length - x.length)
    .join('|');
  const dayFirst = new RegExp(
    `(?<![0-9A-Za-z])(${DIGITISH}{1,2})[\\s.\\-/]*(${names})[a-z]*[\\s.,\\-/]*(${DIGITISH}{2,4})(?![0-9A-Za-z])`,
    'gi',
  );
  for (const m of text.matchAll(dayFirst)) {
    const found = ymd(
      Number(repairDigits(m[3])),
      MONTHS[m[2].toLowerCase()],
      Number(repairDigits(m[1])),
    );
    if (found) return found;
  }
  const monthFirst = new RegExp(
    `(?<![A-Za-z])(${names})[a-z]*\\.?\\s+(${DIGITISH}{1,2}),?\\s+(${DIGITISH}{4})(?![0-9A-Za-z])`,
    'gi',
  );
  for (const m of text.matchAll(monthFirst)) {
    const found = ymd(
      Number(repairDigits(m[3])),
      MONTHS[m[1].toLowerCase()],
      Number(repairDigits(m[2])),
    );
    if (found) return found;
  }
  return null;
}

function findMerchant(lines: string[]): string | null {
  // The first of the top lines that is mostly letters and not a date, phone number or address.
  for (const l of lines.slice(0, 6)) {
    const letters = l.match(/[A-Za-z]/g)?.length ?? 0;
    if (letters < Math.max(3, l.length / 2)) continue;
    if (/^(jl|jln|jalan|telp|tel|phone|hp|npwp|kasir|no)\b/i.test(l) || findDate(l)) continue;
    return l;
  }
  return null;
}

// ---- main ----------------------------------------------------------------------------------------

export function heuristicExtract(text: string): HeuristicResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const warnings: ReceiptWarning[] = [];

  // Total: the LAST line that states the amount to pay. "Final" labels (Grand Total, Total Bayar,
  // Netto ...) beat a plain "Total"; Subtotal, Total Item/Qty/Pajak/Service never count.
  let labelled: number | null = null;
  let labelledKind: 'final' | 'plain' | null = null;
  for (const kind of ['final', 'plain'] as const) {
    for (let i = lines.length - 1; i >= 0 && labelled === null; i--) {
      if (classify(lines[i]) === kind) labelled = amountFor(lines, i);
    }
    if (labelled !== null) {
      labelledKind = kind;
      break;
    }
  }

  // Two lines of the SAME kind stating different totals cannot both be right (a misread, or text added to
  // the receipt to mislead the reader). The last one is still used, but the user is told to look.
  if (labelledKind !== null) {
    const stated = new Set<number>();
    lines.forEach((line, i) => {
      if (classify(line) !== labelledKind) return;
      const amount = amountFor(lines, i);
      if (amount !== null) stated.add(amount);
    });
    if (stated.size > 1) warnings.push('TOTAL_AMBIGUOUS');
  }

  // Cross-check with the payment lines: paid - change must equal the total.
  let tender: number | null = null;
  let change: number | null = null;
  for (const line of lines) {
    if (CHANGE_LABEL.test(line)) {
      const a = amountsOnLine(line);
      if (a.length) change = a[a.length - 1];
    } else if (TENDER_LABEL.test(line) && !classify(line)) {
      const a = amountsOnLine(line).filter((n) => n >= MIN_TOTAL);
      if (a.length) tender = a[a.length - 1];
    }
  }
  const implied = tender !== null && change !== null && tender > change ? tender - change : null;

  let total = labelled;
  if (total === null && implied !== null && implied >= MIN_TOTAL) {
    total = implied;
    warnings.push('TOTAL_DERIVED');
  } else if (total !== null && implied !== null && implied !== total) {
    warnings.push('TOTAL_CONFLICTS_WITH_PAYMENT');
  } else if (total !== null && tender !== null && change === null && tender < total) {
    warnings.push('TOTAL_CONFLICTS_WITH_PAYMENT'); // they cannot have paid less than the total
  }

  return { merchant: findMerchant(lines), date: findDate(text), total, warnings };
}
