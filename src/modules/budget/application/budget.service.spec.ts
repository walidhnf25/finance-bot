import { CategoryRepository } from 'src/modules/category/domain/category.repository';
import { TransactionRepository } from 'src/modules/transaction/domain/transaction.repository';
import { BudgetPeriod } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';
import { BudgetEntity } from '../domain/budget.entity';
import { BudgetRepository } from '../domain/budget.repository';
import { BudgetService } from './budget.service';

function budget(over: Partial<BudgetEntity> = {}): BudgetEntity {
  return {
    id: 'b1',
    userId: 'u1',
    categoryId: 'cat-food',
    amount: Money.fromMajor(2_000_000),
    period: BudgetPeriod.MONTHLY,
    alertThreshold: 80,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('BudgetService', () => {
  let budgets: jest.Mocked<BudgetRepository>;
  let categories: jest.Mocked<CategoryRepository>;
  let transactions: jest.Mocked<TransactionRepository>;
  let service: BudgetService;

  beforeEach(() => {
    budgets = {
      upsert: jest.fn(),
      findForUser: jest.fn(),
      findByCategoryPeriod: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<BudgetRepository>;
    categories = {
      findByKeyword: jest.fn(),
      findById: jest.fn(),
    } as unknown as jest.Mocked<CategoryRepository>;
    transactions = {
      sumByType: jest.fn(),
      sumByCategory: jest.fn(),
    } as unknown as jest.Mocked<TransactionRepository>;
    service = new BudgetService(budgets, categories, transactions);
  });

  describe('setBudget', () => {
    it('scopes the budget to a resolved category', async () => {
      const food = { id: 'cat-food', name: 'Makanan' } as never;
      categories.findByKeyword.mockResolvedValue(food);
      budgets.upsert.mockResolvedValue(budget());

      const result = await service.setBudget(
        'u1',
        ['makan'],
        Money.fromMajor(2_000_000),
        BudgetPeriod.MONTHLY,
      );
      expect(budgets.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ categoryId: 'cat-food' }),
      );
      expect(result.category).toBe(food);
    });

    it('creates an overall budget when no keyword resolves', async () => {
      categories.findByKeyword.mockResolvedValue(null);
      budgets.upsert.mockResolvedValue(budget({ categoryId: null }));
      const result = await service.setBudget(
        'u1',
        [],
        Money.fromMajor(5_000_000),
        BudgetPeriod.MONTHLY,
      );
      expect(budgets.upsert).toHaveBeenCalledWith(expect.objectContaining({ categoryId: null }));
      expect(result.category).toBeNull();
    });
  });

  describe('evaluate', () => {
    it('alerts when category usage crosses the threshold', async () => {
      budgets.findForUser.mockResolvedValue([budget()]); // 2jt monthly, threshold 80
      transactions.sumByCategory.mockResolvedValue([
        { categoryId: 'cat-food', total: Money.fromMajor(1_800_000) },
      ]);
      categories.findById.mockResolvedValue({ name: 'Makanan' } as never);

      const alerts = await service.evaluate('u1', 'cat-food', new Date(), 'Asia/Jakarta');
      expect(alerts).toHaveLength(1);
      expect(alerts[0].percent).toBe(90);
      expect(alerts[0].exceeded).toBe(false);
      expect(alerts[0].categoryName).toBe('Makanan');
    });

    it('flags exceeded when usage is at or above 100%', async () => {
      budgets.findForUser.mockResolvedValue([budget({ categoryId: null })]); // overall
      transactions.sumByType.mockResolvedValue({
        income: Money.zero(),
        expense: Money.fromMajor(2_100_000),
      });

      const alerts = await service.evaluate('u1', 'cat-food', new Date(), 'Asia/Jakarta');
      expect(alerts[0].exceeded).toBe(true);
      expect(alerts[0].categoryName).toBe('Keseluruhan');
    });

    it('is silent below the threshold', async () => {
      budgets.findForUser.mockResolvedValue([budget()]);
      transactions.sumByCategory.mockResolvedValue([
        { categoryId: 'cat-food', total: Money.fromMajor(500_000) },
      ]);
      const alerts = await service.evaluate('u1', 'cat-food', new Date(), 'Asia/Jakarta');
      expect(alerts).toHaveLength(0);
    });

    it('ignores budgets for other categories', async () => {
      budgets.findForUser.mockResolvedValue([budget({ categoryId: 'cat-other' })]);
      const alerts = await service.evaluate('u1', 'cat-food', new Date(), 'Asia/Jakarta');
      expect(alerts).toHaveLength(0);
      expect(transactions.sumByCategory).not.toHaveBeenCalled();
    });
  });
});
