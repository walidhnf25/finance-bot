import { Injectable } from '@nestjs/common';
import { Category as CategoryRow } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from 'src/database/prisma.service';
import { TransactionType } from 'src/shared/domain/enums';
import { normalizeText } from 'src/shared/utils/string-normalizer';
import {
  CategoryEntity,
  CreateCategoryInput,
  FindByKeywordOptions,
} from '../domain/category.entity';
import { CategoryRepository } from '../domain/category.repository';

function toEntity(row: CategoryRow): CategoryEntity {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    type: row.type as TransactionType,
    icon: row.icon,
    isSystem: row.isSystem,
    createdAt: row.createdAt,
  };
}

/**
 * Categories: system ones (user_id NULL, shared by everyone) plus a user's own. A user can only
 * ever see system categories and their own, never another user's.
 */
@Injectable()
export class PrismaCategoryRepository extends CategoryRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findById(id: string, userId: string): Promise<CategoryEntity | null> {
    const row = await this.prisma.category.findFirst({
      where: { id, OR: [{ userId }, { isSystem: true }] },
    });
    return row ? toEntity(row) : null;
  }

  async findByKeyword(
    keyword: string,
    options?: FindByKeywordOptions,
  ): Promise<CategoryEntity | null> {
    const normalized = normalizeText(keyword);
    const rows = await this.prisma.category.findMany({
      where: {
        // System categories, plus this user's own when provided.
        OR: [{ userId: null }, ...(options?.userId ? [{ userId: options.userId }] : [])],
        ...(options?.type ? { type: options.type } : {}),
        keywords: { has: normalized },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) return null;

    // Prefer the user's own category over a system one.
    return toEntity(rows.find((r) => r.userId !== null) ?? rows[0]);
  }

  async findByNameAndType(
    name: string,
    type: TransactionType,
    userId: string | null = null,
  ): Promise<CategoryEntity | null> {
    const row = await this.prisma.category.findFirst({ where: { name, type, userId } });
    return row ? toEntity(row) : null;
  }

  async findAllForUser(userId: string): Promise<CategoryEntity[]> {
    const rows = await this.prisma.category.findMany({
      where: { OR: [{ userId: null }, { userId }] },
    });
    return rows
      .map(toEntity)
      .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name));
  }

  async findSystem(): Promise<CategoryEntity[]> {
    const rows = await this.prisma.category.findMany({
      where: { userId: null },
      orderBy: { name: 'asc' },
    });
    return rows.map(toEntity);
  }

  async create(input: CreateCategoryInput): Promise<CategoryEntity> {
    const row = await this.prisma.category.create({
      data: {
        id: randomUUID(),
        userId: input.userId ?? null,
        name: input.name,
        type: input.type,
        icon: input.icon ?? null,
        isSystem: input.isSystem ?? false,
        keywords: [],
      },
    });
    return toEntity(row);
  }
}
