import { CategoryRepository } from 'src/modules/category/domain/category.repository';
import { SummaryPeriod } from 'src/modules/parser/domain/parsed-intent';
import { TransactionRepository } from 'src/modules/transaction/domain/transaction.repository';
import { Money } from 'src/shared/utils/money';
import { ReportService } from './report.service';

describe('ReportService', () => {
  let transactions: jest.Mocked<TransactionRepository>;
  let categories: jest.Mocked<CategoryRepository>;
  let service: ReportService;

  beforeEach(() => {
    transactions = {
      sumByType: jest.fn(),
      sumByCategory: jest.fn(),
    } as unknown as jest.Mocked<TransactionRepository>;
    categories = { findById: jest.fn() } as unknown as jest.Mocked<CategoryRepository>;
    service = new ReportService(transactions, categories);
  });

  it('computes balance and resolves category names', async () => {
    transactions.sumByType.mockResolvedValue({
      income: Money.fromMajor(8_000_000),
      expense: Money.fromMajor(3_000_000),
    });
    transactions.sumByCategory.mockResolvedValue([
      { categoryId: 'cat-food', total: Money.fromMajor(1_200_000) },
      { categoryId: null, total: Money.fromMajor(300_000) },
    ]);
    categories.findById.mockResolvedValue({ name: 'Makanan', icon: '🍜' } as never);

    const summary = await service.generateSummary(
      'u1',
      SummaryPeriod.Month,
      new Date('2026-07-15T03:00:00.000Z'),
      'Asia/Jakarta',
    );

    expect(summary.periodLabel).toBe('Bulan Ini');
    expect(summary.balance.toNumber()).toBe(5_000_000);
    expect(summary.categories[0].name).toBe('Makanan');
    expect(summary.categories[1].name).toBe('Tanpa kategori');
  });
});
