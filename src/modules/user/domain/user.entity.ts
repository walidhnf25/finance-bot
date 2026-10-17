import { Wallet, WalletMode } from 'src/shared/domain/enums';

/** Domain representation of an application user (framework/persistence agnostic). */
export interface UserEntity {
  id: string;
  /** Telegram user id (stable across chats) — the user's identity key. */
  telegramId: string;
  /** Telegram chat id to reply to. */
  chatId: string | null;
  displayName: string | null;
  currency: string;
  timezone: string;
  isOnboarded: boolean;
  /** Wallets in use; null = never chosen (legacy behaviour, see WalletMode). */
  walletMode: WalletMode | null;
  /** Wallet used when a message doesn't name one; null = never chosen (behaves as CASH). */
  defaultWallet: Wallet | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  telegramId: string;
  chatId?: string | null;
  displayName?: string | null;
}

export interface UpdateUserInput {
  chatId?: string | null;
  displayName?: string | null;
  currency?: string;
  timezone?: string;
  isOnboarded?: boolean;
  defaultWallet?: Wallet | null;
  walletMode?: WalletMode | null;
}
