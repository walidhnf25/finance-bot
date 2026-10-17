import { Money } from 'src/shared/utils/money';
import { TransactionType, Wallet } from 'src/shared/domain/enums';

export interface TransactionEntity {
  id: string;
  userId: string;
  categoryId: string | null;
  type: TransactionType;
  amount: Money;
  description: string;
  note: string | null;
  occurredAt: Date;
  sourceMessage: string | null;
  messageId: string | null;
  /** null = older row / no wallet named: counts as CASH. */
  wallet: Wallet | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTransactionInput {
  userId: string;
  categoryId?: string | null;
  type: TransactionType;
  amount: Money;
  description: string;
  note?: string | null;
  occurredAt: Date;
  sourceMessage?: string | null;
  messageId?: string | null;
  wallet?: Wallet | null;
}

export interface UpdateTransactionInput {
  categoryId?: string | null;
  type?: TransactionType;
  amount?: Money;
  description?: string;
  note?: string | null;
  occurredAt?: Date;
  wallet?: Wallet | null;
}

export interface DateRange {
  start: Date;
  end: Date;
}

export interface TypedTotals {
  income: Money;
  expense: Money;
}

export interface CategoryTotal {
  categoryId: string | null;
  total: Money;
}
