import { Injectable } from '@nestjs/common';
import { CategoryRepository } from 'src/modules/category/domain/category.repository';
import { DateRangeSpec, SummaryPeriod } from 'src/modules/parser/domain/parsed-intent';
import { TransactionRepository } from 'src/modules/transaction/domain/transaction.repository';
import { TransactionType } from 'src/shared/domain/enums';
import { CategoryBreakdown, SummaryResult } from '../domain/summary.types';
import { customRangeInfo, resolvePeriod } from './period';

/**
 * Builds income/expense summaries with a per-category expense breakdown for a
 * given period, aggregating at the database via the transaction repository.
 */
@Injectable()
export class ReportService {
  constructor(
    private readonly transactions: TransactionRepository,
    private readonly categories: CategoryRepository,
  ) {}

  async generateSummary(
    userId: string,
    period: SummaryPeriod,
    now: Date,
    tz: string,
    customRange?: DateRangeSpec,
  ): Promise<SummaryResult> {
    const { range, label } = customRange
      ? customRangeInfo(customRange, tz)
      : resolvePeriod(period, now, tz);

    const totals = await this.transactions.sumByType(userId, range);
    const balance = totals.income.subtract(totals.expense);

    const categoryTotals = await this.transactions.sumByCategory(
      userId,
      range,
      TransactionType.EXPENSE,
    );

    const categories: CategoryBreakdown[] = await Promise.all(
      categoryTotals.map(async (ct) => {
        const category = ct.categoryId
          ? await this.categories.findById(ct.categoryId, userId)
          : null;
        return {
          name: category?.name ?? 'Tanpa kategori',
          icon: category?.icon ?? '📦',
          total: ct.total,
        };
      }),
    );

    return {
      periodLabel: label,
      range,
      income: totals.income,
      expense: totals.expense,
      balance,
      categories,
    };
  }
}
