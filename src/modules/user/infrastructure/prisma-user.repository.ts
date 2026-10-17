import { Injectable } from '@nestjs/common';
import { User as UserRow } from '@prisma/client';
import { isUniqueViolation, PrismaService } from 'src/database/prisma.service';
import { Wallet, WalletMode } from 'src/shared/domain/enums';
import { CreateUserInput, UpdateUserInput, UserEntity } from '../domain/user.entity';
import { UserRepository } from '../domain/user.repository';

function toEntity(row: UserRow): UserEntity {
  return {
    id: row.id,
    telegramId: row.telegramId,
    chatId: row.chatId,
    displayName: row.displayName,
    currency: row.currency,
    timezone: row.timezone,
    isOnboarded: row.isOnboarded,
    walletMode: row.walletMode as WalletMode | null,
    defaultWallet: row.defaultWallet as Wallet | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class PrismaUserRepository extends UserRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findById(id: string): Promise<UserEntity | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async findByTelegramId(telegramId: string): Promise<UserEntity | null> {
    const row = await this.prisma.user.findUnique({ where: { telegramId } });
    return row ? toEntity(row) : null;
  }

  async findOrCreate(input: CreateUserInput): Promise<{ user: UserEntity; created: boolean }> {
    const existing = await this.prisma.user.findUnique({ where: { telegramId: input.telegramId } });
    if (existing) {
      // Keep the reply address fresh.
      if (input.chatId && input.chatId !== existing.chatId) {
        const updated = await this.prisma.user.update({
          where: { id: existing.id },
          data: { chatId: input.chatId },
        });
        return { user: toEntity(updated), created: false };
      }
      return { user: toEntity(existing), created: false };
    }

    try {
      const row = await this.prisma.user.create({
        data: {
          telegramId: input.telegramId,
          chatId: input.chatId ?? null,
          displayName: input.displayName ?? null,
        },
      });
      return { user: toEntity(row), created: true };
    } catch (err) {
      // A concurrent first message created the user: the unique key makes that race safe.
      if (!isUniqueViolation(err, ['telegram_id'])) throw err;
      const winner = await this.prisma.user.findUniqueOrThrow({
        where: { telegramId: input.telegramId },
      });
      return { user: toEntity(winner), created: false };
    }
  }

  async update(id: string, patch: UpdateUserInput): Promise<UserEntity> {
    const result = await this.prisma.user.updateMany({ where: { id }, data: patch });
    if (result.count === 0) throw new Error(`User ${id} not found`);
    return toEntity(await this.prisma.user.findUniqueOrThrow({ where: { id } }));
  }
}
