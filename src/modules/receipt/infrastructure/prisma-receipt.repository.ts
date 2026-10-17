import { Injectable } from '@nestjs/common';
import { Prisma, ReceiptDraft as DraftRow } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { isUniqueViolation, PrismaService } from 'src/database/prisma.service';
import { TransactionEntity } from 'src/modules/transaction/domain/transaction.entity';
import { toTransactionEntity } from 'src/database/transaction.mapper';
import {
  ConfirmResult,
  CreateDraftResult,
  ReceiptDraftEntity,
  ReceiptRepository,
} from '../domain/receipt.repository';

const toEntity = (row: DraftRow): ReceiptDraftEntity => ({
  id: row.id,
  userId: row.userId,
  status: row.status,
  imageSha256: row.imageSha256,
  extraction: row.extraction,
  expiresAt: row.expiresAt,
  transactionId: row.transactionId,
  createdAt: row.createdAt,
});

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

@Injectable()
export class PrismaReceiptRepository extends ReceiptRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async createDraft(input: {
    userId: string;
    imageSha256: string;
    extraction: unknown;
    expiresAt: Date;
    now: Date;
  }): Promise<CreateDraftResult> {
    const attempt = (): Promise<CreateDraftResult> =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.receiptDraft.findUnique({
          where: {
            userId_imageSha256: { userId: input.userId, imageSha256: input.imageSha256 },
          },
        });

        if (existing) {
          if (existing.status === 'PENDING' && existing.expiresAt > input.now) {
            return { kind: 'pending_exists', draft: toEntity(existing) };
          }
          if (existing.status === 'CONFIRMED' && existing.transactionId) {
            const tr = await tx.transaction.findFirst({
              where: { id: existing.transactionId, userId: input.userId, deletedAt: null },
              select: { id: true },
            });
            if (tr) return { kind: 'already_confirmed' };
          }
          // Cancelled, expired, or its transaction was deleted: the photo may be used again.
          await tx.receiptDraft.deleteMany({ where: { id: existing.id, userId: input.userId } });
        }

        const row = await tx.receiptDraft.create({
          data: {
            id: randomUUID(),
            userId: input.userId,
            imageSha256: input.imageSha256,
            extraction: asJson(input.extraction),
            expiresAt: input.expiresAt,
          },
        });
        return { kind: 'created', draft: toEntity(row) };
      });

    try {
      return await attempt();
    } catch (err) {
      // Two identical photos racing: the unique key let one in; report the winner.
      if (isUniqueViolation(err, ['user_id', 'image_sha256'])) return attempt();
      throw err;
    }
  }

  async findPendingByImage(
    userId: string,
    imageSha256: string,
    now: Date,
  ): Promise<ReceiptDraftEntity | null> {
    const row = await this.prisma.receiptDraft.findFirst({
      where: { userId, imageSha256, status: 'PENDING', expiresAt: { gt: now } },
    });
    return row ? toEntity(row) : null;
  }

  async findPending(userId: string, now: Date): Promise<ReceiptDraftEntity | null> {
    const row = await this.prisma.receiptDraft.findFirst({
      where: { userId, status: 'PENDING', expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    return row ? toEntity(row) : null;
  }

  async updateExtraction(
    userId: string,
    draftId: string,
    extraction: unknown,
    expiresAt: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.receiptDraft.updateMany({
      where: { id: draftId, userId, status: 'PENDING' },
      data: { extraction: asJson(extraction), expiresAt },
    });
    return count === 1;
  }

  async cancel(userId: string, draftId: string): Promise<boolean> {
    const { count } = await this.prisma.receiptDraft.updateMany({
      where: { id: draftId, userId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    return count === 1;
  }

  countSince(userId: string, since: Date): Promise<number> {
    return this.prisma.receiptDraft.count({ where: { userId, createdAt: { gte: since } } });
  }

  async confirm(
    userId: string,
    draftId: string,
    now: Date,
    build: Parameters<ReceiptRepository['confirm']>[3],
  ): Promise<ConfirmResult> {
    return this.prisma.$transaction(async (tx): Promise<ConfirmResult> => {
      // Row lock: a concurrent confirmation waits here and then sees the final status.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM receipt_drafts WHERE id = ${draftId} AND user_id = ${userId} FOR UPDATE`;
      if (locked.length === 0) return { kind: 'not_found' };

      const draft = await tx.receiptDraft.findFirstOrThrow({ where: { id: draftId, userId } });
      if (draft.status === 'CONFIRMED') return { kind: 'already_confirmed' };
      if (draft.status === 'CANCELLED') return { kind: 'cancelled' };
      if (draft.status === 'EXPIRED' || draft.expiresAt <= now) {
        if (draft.status !== 'EXPIRED') {
          await tx.receiptDraft.updateMany({
            where: { id: draftId, userId },
            data: { status: 'EXPIRED' },
          });
        }
        return { kind: 'expired' };
      }

      const input = await build(draft.extraction);
      const row = await tx.transaction.create({
        data: {
          id: randomUUID(),
          userId,
          categoryId: input.categoryId ?? null,
          type: input.type,
          amountMinor: input.amount.minorUnits,
          description: input.description,
          note: input.note ?? null,
          occurredAt: input.occurredAt,
          sourceMessage: input.sourceMessage ?? null,
          idempotencyKey: `receipt:${draftId}`,
          wallet: input.wallet ?? null,
        },
      });
      await tx.receiptDraft.updateMany({
        where: { id: draftId, userId },
        data: { status: 'CONFIRMED', transactionId: row.id },
      });
      const transaction: TransactionEntity = toTransactionEntity(row);
      return { kind: 'confirmed', transaction };
    });
  }
}
