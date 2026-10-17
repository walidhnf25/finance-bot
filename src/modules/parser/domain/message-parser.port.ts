import { Wallet, WalletMode } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';
import { ParsedIntent } from './parsed-intent';

export interface ParseInput {
  /** Raw inbound message text. */
  text: string;
  /** Reference "now" (defaults to current time). Injected for deterministic tests. */
  now?: Date;
  /** IANA timezone for relative-date resolution (defaults to Asia/Jakarta). */
  timezone?: string;
}

/**
 * Port for turning a natural-language message into a structured {@link ParsedIntent}.
 * The abstract class doubles as the DI token. Implementations are selected at
 * runtime via `PARSER_DRIVER` (rule | openai | gemini | ollama). Only the
 * rule-based driver exists today; the async signature keeps AI drivers pluggable.
 */
export abstract class MessageParser {
  abstract parse(input: ParseInput): Promise<ParsedIntent>;

  /** Extract a bare amount (clarification flow). Returns null when none found. */
  abstract parseAmount(text: string): Money | null;

  /** Extract a wallet name (clarification flow). Returns null when none found. */
  abstract parseWallet(text: string): Wallet | null;

  /** Read an answer to the wallet setup question (1 / 2 / 3, cash, digital, both). */
  abstract parseWalletMode(text: string): WalletMode | null;
}
