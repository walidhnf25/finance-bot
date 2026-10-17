import { BudgetPeriod, TransactionType, Wallet } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';

export enum IntentType {
  RecordTransaction = 'RECORD_TRANSACTION',
  RecordMany = 'RECORD_MANY',
  Summary = 'SUMMARY',
  SetBudget = 'SET_BUDGET',
  EditTransaction = 'EDIT_TRANSACTION',
  DeleteTransaction = 'DELETE_TRANSACTION',
  Export = 'EXPORT',
  ResetData = 'RESET_DATA',
  Balance = 'BALANCE',
  SetupWallets = 'SETUP_WALLETS',
  Transfer = 'TRANSFER',
  DeleteTransfer = 'DELETE_TRANSFER',
  SetOpeningBalance = 'SET_OPENING_BALANCE',
  SetDefaultWallet = 'SET_DEFAULT_WALLET',
  Help = 'HELP',
  Greeting = 'GREETING',
  /** A bare amount ("25 ribu") — used to complete a pending clarification. */
  AmountOnly = 'AMOUNT_ONLY',
  Unknown = 'UNKNOWN',
}

export enum SummaryPeriod {
  Day = 'DAY',
  Week = 'WEEK',
  Month = 'MONTH',
}

interface BaseIntent {
  type: IntentType;
  /** Original (trimmed) message text. */
  raw: string;
}

export interface RecordTransactionIntent extends BaseIntent {
  type: IntentType.RecordTransaction;
  transactionType: TransactionType;
  /** null => amount missing; caller should ask for it (clarification flow). */
  amount: Money | null;
  description: string;
  /** Candidate keywords for category resolution (most specific first). */
  keywords: string[];
  occurredAt: Date;
  /** Wallet named in the message, or null when not stated. */
  wallet: Wallet | null;
}

/** Several complete transactions in one message ("beli ayam 8rb, beli es teh 5rb"). */
export interface RecordManyIntent extends BaseIntent {
  type: IntentType.RecordMany;
  /** Every item has an amount. */
  items: RecordTransactionIntent[];
}

/** Explicit start/end range (from "dari … sampai …"), overrides `period`. */
export interface DateRangeSpec {
  start: Date;
  end: Date;
}

export interface SummaryIntent extends BaseIntent {
  type: IntentType.Summary;
  period: SummaryPeriod;
  customRange?: DateRangeSpec;
}

export interface SetBudgetIntent extends BaseIntent {
  type: IntentType.SetBudget;
  amount: Money | null;
  keywords: string[];
  period: BudgetPeriod;
}

export interface EditTransactionIntent extends BaseIntent {
  type: IntentType.EditTransaction;
  /** New amount if the user provided one. */
  amount: Money | null;
  /** New category keywords if the user provided any. */
  keywords: string[];
  /** New wallet if the user named one. */
  wallet: Wallet | null;
}

export interface DeleteTransactionIntent extends BaseIntent {
  type: IntentType.DeleteTransaction;
}

export interface ExportIntent extends BaseIntent {
  type: IntentType.Export;
  period: SummaryPeriod;
  customRange?: DateRangeSpec;
}

export interface ResetDataIntent extends BaseIntent {
  type: IntentType.ResetData;
}

export interface BalanceIntent extends BaseIntent {
  type: IntentType.Balance;
}

/** Move money between wallets. `from`/`to` are null when the message left them out. */
export interface SetupWalletsIntent extends BaseIntent {
  type: IntentType.SetupWallets;
}

export interface TransferIntent extends BaseIntent {
  type: IntentType.Transfer;
  from: Wallet | null;
  to: Wallet | null;
  amount: Money | null;
}

export interface DeleteTransferIntent extends BaseIntent {
  type: IntentType.DeleteTransfer;
}

export interface SetOpeningBalanceIntent extends BaseIntent {
  type: IntentType.SetOpeningBalance;
  wallet: Wallet | null;
  amount: Money | null;
}

export interface SetDefaultWalletIntent extends BaseIntent {
  type: IntentType.SetDefaultWallet;
  wallet: Wallet | null;
}

export interface HelpIntent extends BaseIntent {
  type: IntentType.Help;
}

export interface GreetingIntent extends BaseIntent {
  type: IntentType.Greeting;
}

export interface AmountOnlyIntent extends BaseIntent {
  type: IntentType.AmountOnly;
  amount: Money;
}

export interface UnknownIntent extends BaseIntent {
  type: IntentType.Unknown;
}

export type ParsedIntent =
  | RecordTransactionIntent
  | RecordManyIntent
  | SummaryIntent
  | SetBudgetIntent
  | EditTransactionIntent
  | DeleteTransactionIntent
  | ExportIntent
  | ResetDataIntent
  | BalanceIntent
  | SetupWalletsIntent
  | TransferIntent
  | DeleteTransferIntent
  | SetOpeningBalanceIntent
  | SetDefaultWalletIntent
  | HelpIntent
  | GreetingIntent
  | AmountOnlyIntent
  | UnknownIntent;
