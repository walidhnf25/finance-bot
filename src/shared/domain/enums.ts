/**
 * Domain-level enums. The string values are what gets stored in the
 * database, so they must stay stable. The domain never imports storage
 * code, keeping the core independent of the persistence detail.
 */

export enum TransactionType {
  INCOME = 'INCOME',
  EXPENSE = 'EXPENSE',
}

export enum BudgetPeriod {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
}

export enum ConversationState {
  IDLE = 'IDLE',
  AWAITING_AMOUNT = 'AWAITING_AMOUNT',
  AWAITING_WALLET = 'AWAITING_WALLET',
  AWAITING_WALLET_MODE = 'AWAITING_WALLET_MODE',
  AWAITING_OPENING_BALANCE = 'AWAITING_OPENING_BALANCE',
  AWAITING_RECEIPT_CONFIRM = 'AWAITING_RECEIPT_CONFIRM',
  AWAITING_CATEGORY = 'AWAITING_CATEGORY',
  AWAITING_CONFIRM = 'AWAITING_CONFIRM',
  AWAITING_DELETE_CONFIRM = 'AWAITING_DELETE_CONFIRM',
}

/**
 * Where the money sits. A transaction with no stored wallet (older rows) counts
 * as CASH, so existing ledgers keep their meaning.
 */
export enum Wallet {
  CASH = 'CASH',
  DIGITAL = 'DIGITAL',
}

export const DEFAULT_WALLET = Wallet.CASH;

/**
 * Which wallets a user works with. A user with no stored mode is "legacy": wallets
 * stay off until they use a wallet feature, then behave as BOTH.
 */
export enum WalletMode {
  CASH = 'CASH',
  DIGITAL = 'DIGITAL',
  BOTH = 'BOTH',
}

/** Wallets that are active for a mode; null (legacy / not chosen) shows both. */
export function activeWallets(mode: WalletMode | null): Wallet[] {
  if (mode === WalletMode.CASH) return [Wallet.CASH];
  if (mode === WalletMode.DIGITAL) return [Wallet.DIGITAL];
  return [Wallet.CASH, Wallet.DIGITAL];
}
