import { findDate } from './heuristic-extractor';
import { MAX_MERCHANT_LENGTH, sanitizeText } from './receipt-extraction';
import { extractAmount } from 'src/modules/parser/rule-based/amount.tokenizer';
import { extractDate } from 'src/modules/parser/rule-based/date.tokenizer';
import { Wallet } from 'src/shared/domain/enums';

/** A change the user asked for while a receipt draft is waiting for confirmation. */
export interface ReceiptCorrection {
  /** Whole rupiah. */
  total?: number;
  /** `YYYY-MM-DD`. */
  date?: string;
  wallet?: Wallet;
  merchant?: string;
  categoryHint?: string;
}

const KEYWORD = /^\s*(total|jumlah|tanggal|tgl|dompet|toko|merchant|kategori)\b[\s:=]*(.*)$/i;

const dayKey = (date: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

/**
 * Understands short corrections written like a chat message: "total 45rb", "tanggal 3/10/2026",
 * "tanggal kemarin", "dompet digital", "toko Indomaret", "kategori makan". Several can be given on
 * separate lines. Returns null when the text is not a correction at all.
 */
export function parseReceiptCorrection(
  text: string,
  now: Date,
  timezone: string,
  parseWallet: (text: string) => Wallet | null,
): ReceiptCorrection | null {
  const result: ReceiptCorrection = {};

  for (const line of text.split(/\r?\n|;/)) {
    const m = KEYWORD.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (!value) continue;

    if (key === 'total' || key === 'jumlah') {
      const amount = extractAmount(value);
      if (amount) {
        const major = Number(amount.amount.toDecimalString());
        if (Number.isFinite(major) && major > 0) result.total = Math.round(major);
      }
    } else if (key === 'tanggal' || key === 'tgl') {
      const explicit = findDate(value);
      if (explicit) {
        result.date = explicit;
      } else {
        const relative = extractDate(value, now, timezone);
        if (relative) result.date = dayKey(relative.date, timezone);
      }
    } else if (key === 'dompet') {
      const wallet = parseWallet(value);
      if (wallet) result.wallet = wallet;
    } else if (key === 'toko' || key === 'merchant') {
      const merchant = sanitizeText(value, MAX_MERCHANT_LENGTH);
      if (merchant) result.merchant = merchant;
    } else if (key === 'kategori') {
      const hint = sanitizeText(value, 40).toLowerCase();
      if (hint) result.categoryHint = hint;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}
