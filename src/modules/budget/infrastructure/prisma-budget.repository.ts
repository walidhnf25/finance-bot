import { Injectable } from '@nestjs/common';
import { Budget as BudgetRow } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { BudgetPeriod } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';
import { BudgetEntity, UpsertBudgetInput } from '../domain/budget.entity';
import { BudgetRepository } from '../domain/budget.repository';

const DEFAULT_ALERT_THRESHOLD = 80;

/** Overall budgets have no category; their scope key is the literal `ALL`. */
const scopeKey = (categoryId: string | null): string => categoryId ?? 'ALL';

function toEntity(row: BudgetRow): BudgetEntity {
  return {
    id: row.id,
    userId: row.userId,
    categoryId: row.categoryId,
    amount: Money.fromMinor(row.amountMinor),
    period: row.period as BudgetPeriod,
    alertThreshold: row.alertThreshold,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class PrismaBudgetRepository extends BudgetRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /** One budget per (user, category, period); a null category is the overall budget. */
  async upsert(input: UpsertBudgetInput): Promise<BudgetEntity> {
    const categoryId = input.categoryId ?? null;
    const key = { userId: input.userId, scopeKey: scopeKey(categoryId), period: input.period };
    const row = await this.prisma.budget.upsert({
      where: { userId_scopeKey_period: key },
      create: {
        ...key,
        categoryId,
        amountMinor: input.amount.minorUnits,
        alertThreshold: input.alertThreshold ?? DEFAULT_ALERT_THRESHOLD,
      },
      update: {
        amountMinor: input.amount.minorUnits,
        ...(input.alertThreshold !== undefined ? { alertThreshold: input.alertThreshold } : {}),
      },
    });
    return toEntity(row);
  }

  async findForUser(userId: string): Promise<BudgetEntity[]> {
    const rows = await this.prisma.budget.findMany({ where: { userId } });
    return rows.map(toEntity);
  }

  async findByCategoryPeriod(
    userId: string,
    categoryId: string | null,
    period: BudgetPeriod,
  ): Promise<BudgetEntity | null> {
    const row = await this.prisma.budget.findUnique({
      where: { userId_scopeKey_period: { userId, scopeKey: scopeKey(categoryId), period } },
    });
    return row ? toEntity(row) : null;
  }

  async delete(userId: string, id: string): Promise<void> {
    await this.prisma.budget.deleteMany({ where: { id, userId } });
  }
}
