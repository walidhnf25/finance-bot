import { Injectable, Optional } from '@nestjs/common';
import { AuditLogRepository } from 'src/modules/audit/domain/audit-log.repository';
import { CategoryEntity } from 'src/modules/category/domain/category.entity';
import { CategoryRepository } from 'src/modules/category/domain/category.repository';
import { TransactionRepository } from 'src/modules/transaction/domain/transaction.repository';
import { BudgetPeriod, TransactionType } from 'src/shared/domain/enums';
import { DateRange, dayRange, monthRange, weekRange } from 'src/shared/utils/date.util';
import { Money } from 'src/shared/utils/money';
import { BudgetEntity } from '../domain/budget.entity';
import { BudgetRepository } from '../domain/budget.repository';
import { BudgetAlert } from '../domain/budget-alert';

export interface SetBudgetResult {
  budget: BudgetEntity;
  category: CategoryEntity | null;
}

/**
 * Manages spending budgets and evaluates threshold crossings after expenses.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly budgets: BudgetRepository,
    private readonly categories: CategoryRepository,
    private readonly transactions: TransactionRepository,
    @Optional() private readonly audit?: AuditLogRepository,
  ) {}

  /**
   * Set (or replace) a budget. If a keyword resolves to a category the budget is
   * scoped to it; otherwise it becomes an overall budget.
   */
  async setBudget(
    userId: string,
    keywords: string[],
    amount: Money,
    period: BudgetPeriod,
  ): Promise<SetBudgetResult> {
    let category: CategoryEntity | null = null;
    for (const keyword of keywords) {
      const match = await this.categories.findByKeyword(keyword, {
        type: TransactionType.EXPENSE,
        userId,
      });
      if (match) {
        category = match;
        break;
      }
    }

    const budget = await this.budgets.upsert({
      userId,
      categoryId: category?.id ?? null,
      amount,
      period,
    });
    await this.audit?.record({
      userId,
      action: 'BUDGET_SET',
      metadata: { budgetId: budget.id, period, scope: category ? 'category' : 'all' },
    });
    return { budget, category };
  }

  /**
   * After an expense in `categoryId`, return alerts for any budget (that
   * category's or the overall one) whose usage reached its alert threshold.
   */
  async evaluate(
    userId: string,
    categoryId: string | null,
    now: Date,
    tz: string,
  ): Promise<BudgetAlert[]> {
    const budgets = await this.budgets.findForUser(userId);
    const alerts: BudgetAlert[] = [];

    for (const budget of budgets) {
      const isRelevant = budget.categoryId === null || budget.categoryId === categoryId;
      if (!isRelevant || budget.amount.isZero()) continue;

      const range = this.rangeFor(budget.period, now, tz);
      const used = await this.usedAmount(userId, budget.categoryId, range);
      const percent = Math.round((used.toNumber() / budget.amount.toNumber()) * 100);

      if (percent >= budget.alertThreshold) {
        alerts.push({
          categoryName: await this.scopeName(budget.categoryId, userId),
          period: budget.period,
          used,
          limit: budget.amount,
          percent,
          exceeded: percent >= 100,
        });
      }
    }

    return alerts;
  }

  private async usedAmount(
    userId: string,
    categoryId: string | null,
    range: DateRange,
  ): Promise<Money> {
    if (categoryId === null) {
      return (await this.transactions.sumByType(userId, range)).expense;
    }
    const totals = await this.transactions.sumByCategory(userId, range, TransactionType.EXPENSE);
    return totals.find((t) => t.categoryId === categoryId)?.total ?? Money.zero();
  }

  private async scopeName(categoryId: string | null, userId: string): Promise<string> {
    if (categoryId === null) return 'Keseluruhan';
    const category = await this.categories.findById(categoryId, userId);
    return category?.name ?? 'Kategori';
  }

  private rangeFor(period: BudgetPeriod, now: Date, tz: string): DateRange {
    switch (period) {
      case BudgetPeriod.DAILY:
        return dayRange(now, tz);
      case BudgetPeriod.WEEKLY:
        return weekRange(now, tz);
      case BudgetPeriod.MONTHLY:
      default:
        return monthRange(now, tz);
    }
  }
}
