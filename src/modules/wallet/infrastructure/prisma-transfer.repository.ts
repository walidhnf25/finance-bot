import { Injectable } from '@nestjs/common';
import { Transfer as TransferRow } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { isUniqueViolation, PrismaService } from 'src/database/prisma.service';
import { Wallet } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';
import {
  CreateTransferInput,
  TransferEntity,
  TransferRange,
  TransferTotals,
} from '../domain/transfer.entity';
import { TransferRepository } from '../domain/transfer.repository';

function toEntity(row: TransferRow): TransferEntity {
  return {
    id: row.id,
    userId: row.userId,
    from: row.fromWallet as Wallet,
    to: row.toWallet as Wallet,
    amount: Money.fromMinor(row.amountMinor),
    note: row.note,
    occurredAt: row.occurredAt,
    messageId: row.idempotencyKey,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  };
}

const zeroTotals = (): TransferTotals => ({ in: Money.zero(), out: Money.zero() });

/**
 * A transfer is one row that debits `from` and credits `to` at the same instant, so the two sides
 * can never disagree. The database rejects a transfer to the same wallet or a non-positive amount.
 */
@Injectable()
export class PrismaTransferRepository extends TransferRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(input: CreateTransferInput): Promise<TransferEntity | null> {
    try {
      const row = await this.prisma.transfer.create({
        data: {
          id: randomUUID(),
          userId: input.userId,
          fromWallet: input.from,
          toWallet: input.to,
          amountMinor: input.amount.minorUnits,
          note: input.note ?? null,
          occurredAt: input.occurredAt,
          idempotencyKey: input.messageId ?? null,
        },
      });
      return toEntity(row);
    } catch (err) {
      if (isUniqueViolation(err, ['user_id', 'idempotency_key'])) return null;
      throw err;
    }
  }

  async findLatestForUser(userId: string): Promise<TransferEntity | null> {
    const row = await this.prisma.transfer.findFirst({
      where: { userId, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }],
    });
    return row ? toEntity(row) : null;
  }

  async softDelete(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.transfer.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) throw new Error('Transfer not found');
  }

  async existsByMessageId(userId: string, messageId: string): Promise<boolean> {
    return (await this.prisma.transfer.count({ where: { userId, idempotencyKey: messageId } })) > 0;
  }

  async findManyInRange(userId: string, range: TransferRange): Promise<TransferEntity[]> {
    const rows = await this.prisma.transfer.findMany({
      where: { userId, deletedAt: null, occurredAt: { gte: range.start, lte: range.end } },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map(toEntity);
  }

  async sumByWallet(
    userId: string,
    range?: TransferRange,
  ): Promise<Record<Wallet, TransferTotals>> {
    const where = {
      userId,
      deletedAt: null,
      ...(range ? { occurredAt: { gte: range.start, lte: range.end } } : {}),
    };
    const [sent, received] = await Promise.all([
      this.prisma.transfer.groupBy({ by: ['fromWallet'], where, _sum: { amountMinor: true } }),
      this.prisma.transfer.groupBy({ by: ['toWallet'], where, _sum: { amountMinor: true } }),
    ]);
    const totals: Record<Wallet, TransferTotals> = {
      [Wallet.CASH]: zeroTotals(),
      [Wallet.DIGITAL]: zeroTotals(),
    };
    for (const g of sent) {
      totals[g.fromWallet as Wallet].out = Money.fromMinor(g._sum.amountMinor ?? 0n);
    }
    for (const g of received) {
      totals[g.toWallet as Wallet].in = Money.fromMinor(g._sum.amountMinor ?? 0n);
    }
    return totals;
  }

  async hasAny(userId: string): Promise<boolean> {
    return (await this.prisma.transfer.count({ where: { userId, deletedAt: null }, take: 1 })) > 0;
  }
}
