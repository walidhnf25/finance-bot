import { Transaction as TransactionRow } from '@prisma/client';
import { TransactionEntity } from 'src/modules/transaction/domain/transaction.entity';
import { TransactionType, Wallet } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';

/**
 * Prisma row -> domain entity. Shared by every repository that reads or creates a transaction row
 * (the transaction repository and the atomic receipt confirmation), so they cannot disagree.
 */
export function toTransactionEntity(row: TransactionRow): TransactionEntity {
  return {
    id: row.id,
    userId: row.userId,
    categoryId: row.categoryId,
    type: row.type as TransactionType,
    amount: Money.fromMinor(row.amountMinor),
    description: row.description,
    note: row.note,
    occurredAt: row.occurredAt,
    sourceMessage: row.sourceMessage,
    messageId: row.idempotencyKey,
    wallet: row.wallet as Wallet | null,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
