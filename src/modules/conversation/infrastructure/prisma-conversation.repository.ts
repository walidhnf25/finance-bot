import { Injectable } from '@nestjs/common';
import { Conversation as ConversationRow, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { ConversationState } from 'src/shared/domain/enums';
import {
  ConversationContextEntity,
  ConversationPayload,
  SetContextInput,
} from '../domain/conversation-context.entity';
import { ConversationRepository } from '../domain/conversation.repository';

function toEntity(row: ConversationRow): ConversationContextEntity {
  return {
    id: row.id,
    userId: row.userId,
    state: row.state as ConversationState,
    payload: (row.payload as ConversationPayload | null) ?? null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** One row per user (unique `user_id`), so concurrent writers can never create two contexts. */
@Injectable()
export class PrismaConversationRepository extends ConversationRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async getActive(userId: string, now: Date): Promise<ConversationContextEntity | null> {
    const row = await this.prisma.conversation.findUnique({ where: { userId } });
    if (!row || row.state === ConversationState.IDLE) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null; // expired
    return toEntity(row);
  }

  async set(input: SetContextInput): Promise<ConversationContextEntity> {
    const payload = (input.payload ?? Prisma.DbNull) as
      Prisma.InputJsonValue | typeof Prisma.DbNull;
    const data = { state: input.state, payload, expiresAt: input.expiresAt ?? null };
    const row = await this.prisma.conversation.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, ...data },
      update: data,
    });
    return toEntity(row);
  }

  async clear(userId: string): Promise<void> {
    await this.prisma.conversation.updateMany({
      where: { userId, state: { not: ConversationState.IDLE } },
      data: { state: ConversationState.IDLE, payload: Prisma.DbNull, expiresAt: null },
    });
  }
}
