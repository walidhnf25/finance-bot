import { Injectable } from '@nestjs/common';
import { BudgetPeriod, TransactionType, Wallet, WalletMode } from 'src/shared/domain/enums';
import { DEFAULT_TIMEZONE } from 'src/shared/utils/date.util';
import { Money } from 'src/shared/utils/money';
import { normalizeText, tokenize } from 'src/shared/utils/string-normalizer';
import { MessageParser, ParseInput } from '../domain/message-parser.port';
import {
  IntentType,
  ParsedIntent,
  RecordManyIntent,
  RecordTransactionIntent,
  SummaryPeriod,
} from '../domain/parsed-intent';
import { extractAmount } from './amount.tokenizer';
import { extractDate } from './date.tokenizer';
import { extractDateRange } from './date-range.tokenizer';
import { splitSegments } from './segments';
import {
  BALANCE_WORDS,
  BOTH_WALLET_WORDS,
  BUDGET_WORDS,
  CASH_WALLET_WORDS,
  DEFAULT_WORDS,
  DELETE_WORDS,
  DIGITAL_WALLET_WORDS,
  EDIT_WORDS,
  EXPENSE_VERBS,
  EXPORT_WORDS,
  GREETING_WORDS,
  HELP_WORDS,
  INCOME_WORDS,
  STOPWORDS,
  SUMMARY_WORDS,
  TRANSFER_WORDS,
  WALLET_SETUP_WORDS,
} from './keywords';

const WALLET_WORDS = [...CASH_WALLET_WORDS, ...DIGITAL_WALLET_WORDS];

/**
 * Deterministic, dictionary + regex based parser. No external services.
 * Selected when PARSER_DRIVER=rule. Fully unit-tested and side-effect free.
 */
@Injectable()
export class RuleBasedParser extends MessageParser {
  parse(input: ParseInput): Promise<ParsedIntent> {
    return Promise.resolve(this.parseSync(input));
  }

  parseAmount(text: string): Money | null {
    return extractAmount(text)?.amount ?? null;
  }

  parseWallet(text: string): Wallet | null {
    return this.detectWallet(new Set(tokenize(text)));
  }

  parseWalletMode(text: string): WalletMode | null {
    const tokens = new Set(tokenize(text));
    const cash = CASH_WALLET_WORDS.some((w) => tokens.has(w));
    const digital = DIGITAL_WALLET_WORDS.some((w) => tokens.has(w));
    if (tokens.has('3') || BOTH_WALLET_WORDS.some((w) => tokens.has(w)) || (cash && digital)) {
      return WalletMode.BOTH;
    }
    if (tokens.has('1') || cash) return WalletMode.CASH;
    if (tokens.has('2') || digital) return WalletMode.DIGITAL;
    return null;
  }

  private parseSync(input: ParseInput): ParsedIntent {
    return this.parseMany(input) ?? this.parseOne(input);
  }

  /**
   * A message listing several transactions. Only counts when the message splits into
   * two or more parts and every part is a complete transaction (has an amount);
   * otherwise it is parsed as a single message, exactly as before.
   */
  private parseMany(input: ParseInput): RecordManyIntent | null {
    const raw = input.text.trim();
    const segments = splitSegments(raw);
    if (segments.length < 2) return null;

    const items: RecordTransactionIntent[] = [];
    for (const segment of segments) {
      const intent = this.parseOne({ ...input, text: segment });
      if (intent.type !== IntentType.RecordTransaction || intent.amount === null) return null;
      items.push(intent);
    }

    // A wallet named once ("..., beli es teh 5rb cash") covers the items that name none.
    const named = new Set(items.map((i) => i.wallet).filter((w): w is Wallet => w !== null));
    const shared = named.size === 1 ? [...named][0] : null;
    return {
      type: IntentType.RecordMany,
      raw,
      items: items.map((i) => ({ ...i, wallet: i.wallet ?? shared })),
    };
  }

  private parseOne(input: ParseInput): ParsedIntent {
    const raw = input.text.trim();
    const now = input.now ?? new Date();
    const tz = input.timezone ?? DEFAULT_TIMEZONE;
    const normalized = normalizeText(raw);

    if (normalized.length === 0) {
      return { type: IntentType.Unknown, raw };
    }

    const tokens = new Set(tokenize(raw));
    const has = (words: string[]): boolean =>
      words.some((w) => (w.includes(' ') ? normalized.includes(w) : tokens.has(w)));

    // Delete and edit change stored data, so they only count as COMMANDS at the start of the message
    // ("hapus", "tolong hapus", "ubah jadi 30rb"). Anywhere else the word is part of a description:
    // "beli sabun hapus noda 20rb" and "ganti oli motor 150rb" are expenses, not a deletion or an edit.
    const ordered = tokenize(raw);
    const leads = (words: string[]): boolean => ordered.slice(0, 2).some((t) => words.includes(t));
    const isDeleteCommand = leads(DELETE_WORDS);
    const isEditCommand = this.isEditCommand(ordered);

    // ---- Command intents (priority order) ----
    // Help, reset and budget words only count near the start: "beli menu makan siang 25rb", "kabel reset router
    // 50rb" and "beli batas pengaman 50rb" are expenses, not a help request, a wipe prompt or a budget change.
    const nearStart = (words: string[], n = 3): boolean =>
      ordered.slice(0, n).some((t) => words.includes(t));
    // (a help request carries no number: "beli menu makan siang 25rb" is not one)
    if ((nearStart(HELP_WORDS, 2) || normalized.includes('cara pakai')) && !/\d/.test(raw)) {
      return { type: IntentType.Help, raw };
    }
    // Reset must be checked before delete so "hapus semua" isn't treated as
    // deleting the last transaction.
    if (
      ordered.length <= 4 &&
      (tokens.has('reset') || /\bhapus semua\b|\breset data\b/.test(normalized))
    ) {
      return { type: IntentType.ResetData, raw };
    }
    if (tokens.has('dompet') && has(WALLET_SETUP_WORDS)) {
      return { type: IntentType.SetupWallets, raw };
    }
    if (tokens.has('saldo') && tokens.has('awal')) {
      return {
        type: IntentType.SetOpeningBalance,
        raw,
        wallet: this.detectWallet(tokens),
        // Zero is a valid opening balance (it clears a previously set one).
        amount:
          extractAmount(raw)?.amount ??
          (tokens.has('nol') || /(^|\s)(rp\.?\s*)?0(\s|$)/.test(normalized) ? Money.zero() : null),
      };
    }
    if (has(DEFAULT_WORDS) && this.detectWallet(tokens) !== null) {
      return { type: IntentType.SetDefaultWallet, raw, wallet: this.detectWallet(tokens) };
    }
    const transfer = this.detectTransfer(raw, normalized, tokens, has);
    if (transfer !== null) {
      return transfer;
    }
    if (isDeleteCommand) {
      return { type: IntentType.DeleteTransaction, raw };
    }
    if (has(SUMMARY_WORDS)) {
      const customRange = extractDateRange(raw, now, tz) ?? undefined;
      return { type: IntentType.Summary, raw, period: this.detectPeriod(normalized), customRange };
    }
    if (has(BALANCE_WORDS)) {
      return { type: IntentType.Balance, raw };
    }
    if (has(EXPORT_WORDS)) {
      const customRange = extractDateRange(raw, now, tz) ?? undefined;
      return { type: IntentType.Export, raw, period: this.detectPeriod(normalized), customRange };
    }
    if (nearStart(BUDGET_WORDS)) {
      const amount = extractAmount(raw)?.amount ?? null;
      const keywords = this.extractKeywords(raw, BUDGET_WORDS);
      return {
        type: IntentType.SetBudget,
        raw,
        amount,
        keywords,
        period: this.detectBudgetPeriod(normalized),
      };
    }
    if (isEditCommand) {
      return {
        type: IntentType.EditTransaction,
        raw,
        amount: extractAmount(raw)?.amount ?? null,
        keywords: this.extractKeywords(raw, [...EDIT_WORDS, ...WALLET_WORDS]),
        wallet: this.detectWallet(tokens),
      };
    }

    // ---- Transaction / amount extraction ----
    // Remove a date phrase first so its digits aren't mistaken for an amount.
    const dateMatch = extractDate(raw, now, tz);
    const occurredAt = dateMatch ? dateMatch.date : now;
    const withoutDate = dateMatch ? this.removeSpan(raw, dateMatch.start, dateMatch.end) : raw;

    const amountMatch = extractAmount(withoutDate);
    const amount = amountMatch?.amount ?? null;
    const withoutAmount = amountMatch
      ? this.removeSpan(withoutDate, amountMatch.start, amountMatch.end)
      : withoutDate;

    const wallet = this.detectWallet(tokens);
    const keywords = this.buildKeywords(this.dropWords(withoutAmount, WALLET_WORDS));
    const description = keywords.length > 0 ? keywords[0] : '';

    const hasExpenseVerb = EXPENSE_VERBS.some((v) =>
      v.includes(' ') ? normalized.includes(v) : tokens.has(v),
    );
    const hasIncome = INCOME_WORDS.some((v) => tokens.has(v));
    const transactionType = hasExpenseVerb
      ? TransactionType.EXPENSE
      : hasIncome
        ? TransactionType.INCOME
        : TransactionType.EXPENSE;

    if (amount !== null) {
      if (description.length === 0) {
        // Bare amount — used to complete a pending clarification.
        return { type: IntentType.AmountOnly, raw, amount };
      }
      return {
        type: IntentType.RecordTransaction,
        raw,
        transactionType,
        amount,
        description,
        keywords,
        occurredAt,
        wallet,
      };
    }

    // No amount: only start a transaction (clarification) when there is a cue.
    if (hasExpenseVerb || hasIncome) {
      return {
        type: IntentType.RecordTransaction,
        raw,
        transactionType,
        amount: null,
        description,
        keywords,
        occurredAt,
        wallet,
      };
    }

    if (GREETING_WORDS.some((w) => tokens.has(w))) {
      return { type: IntentType.Greeting, raw };
    }

    return { type: IntentType.Unknown, raw };
  }

  // ---- Helpers ----

  /** What an edit may be pointed at; "ganti oli motor 150rb" names none of these, so it is an expense. */
  private static readonly EDIT_TARGETS = new Set([
    'jadi',
    'menjadi',
    'ke',
    'nominal',
    'jumlah',
    'harga',
    'kategori',
    'dompet',
    'tanggal',
    'deskripsi',
    'keterangan',
    'nama',
    'total',
    'transaksi',
    'terakhir',
    'tadi',
    'yang',
    'salah',
  ]);

  /**
   * "edit ..." is always a command. The softer words ("ganti", "ubah", "koreksi"...) must lead the message
   * (allowing a polite word first) and be followed by an amount or an edit target.
   */
  private isEditCommand(ordered: string[]): boolean {
    const index = ordered.slice(0, 2).findIndex((t) => EDIT_WORDS.includes(t));
    if (index === -1) return false;
    if (ordered[index] === 'edit') return true;
    const rest = ordered.slice(index + 1);
    if (rest.length === 0) return true; // a bare "ganti" asks what to change
    if (RuleBasedParser.EDIT_TARGETS.has(rest[0])) return true; // "ganti jadi ...", "ubah kategori ..."
    // "ganti 2 ban motor 300rb" starts with a number too, yet it is an expense. After an edit word, a number
    // only makes an edit when NOTHING else in the message describes something: it is an amount (with its unit),
    // an edit target, or a wallet.
    const plain = (t: string): boolean =>
      /^(rp\.?)?\d[\d.,]*(rb|ribu|k|jt|juta)?$/.test(t) ||
      /^(rp|rb|ribu|k|jt|juta)$/.test(t) ||
      RuleBasedParser.EDIT_TARGETS.has(t) ||
      WALLET_WORDS.includes(t);
    return /^(rp\.?)?\d/.test(rest[0]) && rest.every(plain);
  }

  /**
   * Wallet-to-wallet transfer. Recognised forms:
   *  - "tarik tunai 500rb"            digital -> cash (ATM withdrawal)
   *  - "setor tunai 200rb"            cash -> digital (bank deposit)
   *  - "pindah 500rb dari digital ke cash" / "pindah 500rb ke cash" / "pindah 500rb dari cash"
   *  - "hapus transfer" / "batal pindah"  undo the latest transfer
   */
  private detectTransfer(
    raw: string,
    normalized: string,
    tokens: Set<string>,
    has: (words: string[]) => boolean,
  ): ParsedIntent | null {
    const isMove = has(TRANSFER_WORDS);
    const isWithdraw = tokens.has('tarik');
    const isDeposit =
      tokens.has('setor') &&
      (tokens.has('tunai') || tokens.has('cash') || tokens.has('kas') || tokens.has('digital'));
    // "hapus transfer" alone is ambiguous with deleting a transaction tagged "transfer",
    // so it only counts when nothing else is said.
    const filler = new Set(['terakhir', 'dompet', 'antar', 'yang', 'tadi', 'itu']);
    const rest = [...tokens].filter((t) => !DELETE_WORDS.includes(t) && !filler.has(t));
    const deleteOnlyTransfer = has(DELETE_WORDS) && rest.length === 1 && rest[0] === 'transfer';
    if (has(DELETE_WORDS) && (isMove || deleteOnlyTransfer)) {
      return { type: IntentType.DeleteTransfer, raw };
    }
    if (!isMove && !isWithdraw && !isDeposit) return null;

    const amount = extractAmount(raw)?.amount ?? null;
    if (isWithdraw)
      return { type: IntentType.Transfer, raw, from: Wallet.DIGITAL, to: Wallet.CASH, amount };
    if (isDeposit)
      return { type: IntentType.Transfer, raw, from: Wallet.CASH, to: Wallet.DIGITAL, amount };

    // Direction from "dari <wallet>" / "ke <wallet>"; a single side implies the other.
    let from: Wallet | null = null;
    let to: Wallet | null = null;
    let marker: 'dari' | 'ke' | null = null;
    for (const token of normalized.split(/\s+/)) {
      if (token === 'dari' || token === 'ke') {
        marker = token;
        continue;
      }
      const wallet = this.detectWallet(new Set([token]));
      if (wallet !== null && marker === 'dari') from = wallet;
      else if (wallet !== null && marker === 'ke') to = wallet;
    }
    if (from !== null && to === null) to = from === Wallet.CASH ? Wallet.DIGITAL : Wallet.CASH;
    if (to !== null && from === null) from = to === Wallet.CASH ? Wallet.DIGITAL : Wallet.CASH;
    return { type: IntentType.Transfer, raw, from, to, amount };
  }

  /** First wallet word found in the message, or null when none is named. */
  private detectWallet(tokens: Set<string>): Wallet | null {
    if (CASH_WALLET_WORDS.some((w) => tokens.has(w))) return Wallet.CASH;
    if (DIGITAL_WALLET_WORDS.some((w) => tokens.has(w))) return Wallet.DIGITAL;
    return null;
  }

  private detectPeriod(normalized: string): SummaryPeriod {
    if (/\bhari\s*ini\b|\bharian\b|\bhari\b|\btoday\b/.test(normalized)) {
      return SummaryPeriod.Day;
    }
    if (/\bminggu\s*ini\b|\bmingguan\b|\bpekan\b|\bminggu\b/.test(normalized)) {
      return SummaryPeriod.Week;
    }
    // default (also matches "bulan ini"/"bulanan"/"bulan")
    return SummaryPeriod.Month;
  }

  private detectBudgetPeriod(normalized: string): BudgetPeriod {
    if (/\bharian\b|\bhari\b/.test(normalized)) return BudgetPeriod.DAILY;
    if (/\bmingguan\b|\bpekan\b|\bminggu\b/.test(normalized)) return BudgetPeriod.WEEKLY;
    return BudgetPeriod.MONTHLY;
  }

  /** Remove a substring span, replacing it with a space to preserve token gaps. */
  private removeSpan(text: string, start: number, end: number): string {
    return `${text.slice(0, start)} ${text.slice(end)}`;
  }

  /** Tokens of `text` minus stopwords — candidate category keywords. */
  private buildKeywords(text: string): string[] {
    const clean = tokenize(text).filter((t) => !STOPWORDS.has(t) && t.length > 0);
    if (clean.length === 0) return [];
    const phrase = clean.join(' ');
    // Most specific first: full phrase, then individual tokens (deduped).
    return [...new Set([phrase, ...clean])];
  }

  /** Keywords after removing amount + a set of command words. */
  private extractKeywords(raw: string, commandWords: string[]): string[] {
    const amountMatch = extractAmount(raw);
    const withoutAmount = amountMatch
      ? this.removeSpan(raw, amountMatch.start, amountMatch.end)
      : raw;
    const stripped = this.stripWords(withoutAmount, commandWords);
    return this.buildKeywords(stripped);
  }

  /** Remove only the given whole words from text. */
  private dropWords(text: string, words: string[]): string {
    const remove = new Set(words);
    return tokenize(text)
      .filter((t) => !remove.has(t))
      .join(' ');
  }

  /** Remove whole-word occurrences of `words` (and period words) from text. */
  private stripWords(text: string, words: string[]): string {
    const remove = new Set([...words, 'harian', 'mingguan', 'bulanan', 'hari', 'minggu', 'bulan']);
    return tokenize(text)
      .filter((t) => !remove.has(t))
      .join(' ');
  }
}
