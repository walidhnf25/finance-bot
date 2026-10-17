import { Wallet } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';

/** Money moved between two of a user's own wallets (not income or expense). */
export interface TransferEntity {
  id: string;
  userId: string;
  from: Wallet;
  to: Wallet;
  amount: Money;
  note: string | null;
  occurredAt: Date;
  messageId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface CreateTransferInput {
  userId: string;
  from: Wallet;
  to: Wallet;
  amount: Money;
  note?: string | null;
  occurredAt: Date;
  messageId?: string | null;
}

export interface TransferRange {
  start: Date;
  end: Date;
}

export interface TransferTotals {
  /** Received by the wallet. */
  in: Money;
  /** Sent from the wallet. */
  out: Money;
}
