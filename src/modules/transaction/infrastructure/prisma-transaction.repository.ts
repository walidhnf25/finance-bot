import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { isUniqueViolation, PrismaService } from 'src/database/prisma.service';
import { toTransactionEntity } from 'src/database/transaction.mapper';
import { DEFAULT_WALLET, TransactionType, Wallet } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';
import {
  CategoryTotal,
  CreateTransactionInput,
  DateRange,
  TransactionEntity,
  TypedTotals,
  UpdateTransactionInput,
} from '../domain/transaction.entity';
import { FindManyOptions, TransactionRepository } from '../domain/transaction.repository';

/** `wallet` filter that treats a missing wallet as CASH (legacy rows). */
function walletFilter(wallet: Wallet): Prisma.TransactionWhereInput {
  return wallet === DEFAULT_WALLET ? { OR: [{ wallet }, { wallet: null }] } : { wallet };
}

const emptyTotals = (): TypedTotals => ({ income: Money.zero(), expense: Money.zero() });

/**
 * PostgreSQL implementation. All queries are scoped by `userId`; aggregates run in the database
 * (BIGINT sums, never floating point); multi-row writes use a single database transaction.
 */
@Injectable()
export class PrismaTransactionRepository extends TransactionRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(input: CreateTransactionInput): Promise<TransactionEntity | null> {
    try {
      return toTransactionEntity(await this.prisma.transaction.create({ data: this.data(input) }));
    } catch (err) {
      if (isUniqueViolation(err, ['user_id', 'idempotency_key'])) return null;
      throw err;
    }
  }

  async createMany(inputs: CreateTransactionInput[]): Promise<Array<TransactionEntity | null>> {
    const run = (): Promise<Array<TransactionEntity | null>> =>
      this.prisma.$transaction(async (tx) => {
        const base = Date.now();
        const results: Array<TransactionEntity | null> = [];
        for (const [index, input] of inputs.entries()) {
          if (input.messageId) {
            const existing = await tx.transaction.findUnique({
              where: {
                userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.messageId },
              },
              select: { id: true },
            });
            if (existing) {
              results.push(null);
              continue;
            }
          }
          // Distinct, increasing creation times keep "latest transaction" well defined.
          const row = await tx.transaction.create({
            data: { ...this.data(input), createdAt: new Date(base + index) },
          });
          results.push(toTransactionEntity(row));
        }
        return results;
      });

    try {
      return await run();
    } catch (err) {
      // A concurrent request committed the same key between our check and insert: the whole
      // batch rolled back, so run it once more; it now sees the committed rows as duplicates.
      if (isUniqueViolation(err, ['user_id', 'idempotency_key'])) return run();
      throw err;
    }
  }

  async findById(userId: string, id: string): Promise<TransactionEntity | null> {
    const row = await this.prisma.transaction.findFirst({ where: { id, userId, deletedAt: null } });
    return row ? toTransactionEntity(row) : null;
  }

  async findLatestForUser(userId: string): Promise<TransactionEntity | null> {
    const row = await this.prisma.transaction.findFirst({
      where: { userId, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }],
    });
    return row ? toTransactionEntity(row) : null;
  }

  async findManyInRange(
    userId: string,
    range: DateRange,
    options?: FindManyOptions,
  ): Promise<TransactionEntity[]> {
    const rows = await this.prisma.transaction.findMany({
      where: {
        userId,
        deletedAt: null,
        occurredAt: { gte: range.start, lte: range.end },
        ...(options?.type ? { type: options.type } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      ...(options?.limit ? { take: options.limit } : {}),
    });
    return rows.map(toTransactionEntity);
  }

  async update(
    userId: string,
    id: string,
    patch: UpdateTransactionInput,
  ): Promise<TransactionEntity> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.transaction.updateMany({
        where: { id, userId, deletedAt: null },
        data: {
          ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.amount !== undefined ? { amountMinor: patch.amount.minorUnits } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
          ...(patch.occurredAt !== undefined ? { occurredAt: patch.occurredAt } : {}),
          ...(patch.wallet !== undefined ? { wallet: patch.wallet } : {}),
          updatedAt: new Date(),
        },
      });
      if (count === 0) throw new Error('Transaction not found');
      return toTransactionEntity(await tx.transaction.findFirstOrThrow({ where: { id, userId } }));
    });
  }

  async softDelete(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.transaction.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) throw new Error('Transaction not found');
  }

  async existsByMessageId(userId: string, messageId: string): Promise<boolean> {
    return (
      (await this.prisma.transaction.count({ where: { userId, idempotencyKey: messageId } })) > 0
    );
  }

  async sumByType(userId: string, range: DateRange): Promise<TypedTotals> {
    const groups = await this.prisma.transaction.groupBy({
      by: ['type'],
      where: { userId, deletedAt: null, occurredAt: { gte: range.start, lte: range.end } },
      _sum: { amountMinor: true },
    });
    const totals = emptyTotals();
    for (const g of groups) {
      const sum = Money.fromMinor(g._sum.amountMinor ?? 0n);
      if (g.type === TransactionType.INCOME) totals.income = sum;
      else totals.expense = sum;
    }
    return totals;
  }

  async sumByWallet(userId: string, range?: DateRange): Promise<Record<Wallet, TypedTotals>> {
    const groups = await this.prisma.transaction.groupBy({
      by: ['wallet', 'type'],
      where: {
        userId,
        deletedAt: null,
        ...(range ? { occurredAt: { gte: range.start, lte: range.end } } : {}),
      },
      _sum: { amountMinor: true },
    });
    const totals: Record<Wallet, TypedTotals> = {
      [Wallet.CASH]: emptyTotals(),
      [Wallet.DIGITAL]: emptyTotals(),
    };
    for (const g of groups) {
      const bucket = totals[(g.wallet as Wallet | null) ?? DEFAULT_WALLET];
      const sum = Money.fromMinor(g._sum.amountMinor ?? 0n);
      if (g.type === TransactionType.INCOME) bucket.income = bucket.income.add(sum);
      else bucket.expense = bucket.expense.add(sum);
    }
    return totals;
  }

  async sumByCategory(
    userId: string,
    range: DateRange,
    type: TransactionType,
    wallet?: Wallet,
  ): Promise<CategoryTotal[]> {
    const groups = await this.prisma.transaction.groupBy({
      by: ['categoryId'],
      where: {
        userId,
        type,
        deletedAt: null,
        occurredAt: { gte: range.start, lte: range.end },
        ...(wallet ? walletFilter(wallet) : {}),
      },
      _sum: { amountMinor: true },
    });
    return groups
      .map((g) => ({ categoryId: g.categoryId, total: Money.fromMinor(g._sum.amountMinor ?? 0n) }))
      .sort((a, b) => b.total.compareTo(a.total));
  }

  async findByNote(userId: string, note: string): Promise<TransactionEntity[]> {
    const rows = await this.prisma.transaction.findMany({
      where: { userId, note, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toTransactionEntity);
  }

  async replaceMarked(
    userId: string,
    wallet: Wallet,
    note: string,
    replacement: CreateTransactionInput | null,
  ): Promise<TransactionEntity | null> {
    return this.prisma.$transaction(async (tx) => {
      // Serialise concurrent replacements for the same (user, marker, wallet): without this, two
      // requests could each find nothing to delete and both insert, leaving two live entries
      // (a double-counted opening balance). The lock is released when the transaction ends.
      await tx.$queryRaw`SELECT 1 AS locked FROM (
        SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${note}:${wallet}`}, 0))
      ) AS lock`;

      // The same message applied twice changes nothing: the first application already did it.
      if (replacement?.messageId) {
        const applied = await tx.transaction.findUnique({
          where: {
            userId_idempotencyKey: { userId, idempotencyKey: replacement.messageId },
          },
        });
        if (applied) return applied.deletedAt === null ? toTransactionEntity(applied) : null;
      }
      await tx.transaction.updateMany({
        where: { userId, note, deletedAt: null, ...walletFilter(wallet) },
        data: { deletedAt: new Date() },
      });
      if (!replacement) return null;
      return toTransactionEntity(await tx.transaction.create({ data: this.data(replacement) }));
    });
  }

  async hasTransactionsInWallet(userId: string, wallet: Wallet): Promise<boolean> {
    return (
      (await this.prisma.transaction.count({
        where: { userId, deletedAt: null, ...walletFilter(wallet) },
        take: 1,
      })) > 0
    );
  }

  async hasExplicitWallet(userId: string): Promise<boolean> {
    return (
      (await this.prisma.transaction.count({
        where: { userId, deletedAt: null, wallet: { not: null } },
        take: 1,
      })) > 0
    );
  }

  private data(input: CreateTransactionInput): Prisma.TransactionUncheckedCreateInput {
    return {
      id: randomUUID(),
      userId: input.userId,
      categoryId: input.categoryId ?? null,
      type: input.type,
      amountMinor: input.amount.minorUnits,
      description: input.description,
      note: input.note ?? null,
      occurredAt: input.occurredAt,
      sourceMessage: input.sourceMessage ?? null,
      idempotencyKey: input.messageId ?? null,
      wallet: input.wallet ?? null,
    };
  }
}
