import { TransactionType } from 'src/shared/domain/enums';
import { CategoryEntity } from '../domain/category.entity';
import { CategoryRepository } from '../domain/category.repository';
import { CategoryResolver } from './category-resolver.service';

function makeCategory(name: string, type: TransactionType): CategoryEntity {
  return {
    id: `id-${name}`,
    userId: null,
    name,
    type,
    icon: null,
    isSystem: true,
    createdAt: new Date(),
  };
}

describe('CategoryResolver', () => {
  it('returns the first keyword that resolves', async () => {
    const food = makeCategory('Makanan', TransactionType.EXPENSE);
    const repo: Partial<CategoryRepository> = {
      findByKeyword: jest
        .fn()
        .mockResolvedValueOnce(null) // "beli kopi" phrase misses
        .mockResolvedValueOnce(food), // "kopi" hits
      findByNameAndType: jest.fn(),
    };
    const resolver = new CategoryResolver(repo as CategoryRepository);

    const result = await resolver.resolve(['beli kopi', 'kopi'], TransactionType.EXPENSE, 'u1');
    expect(result).toBe(food);
    expect(repo.findByNameAndType).not.toHaveBeenCalled();
  });

  it('falls back to the default category when nothing matches', async () => {
    const fallback = makeCategory('Lainnya', TransactionType.EXPENSE);
    const repo: Partial<CategoryRepository> = {
      findByKeyword: jest.fn().mockResolvedValue(null),
      findByNameAndType: jest.fn().mockResolvedValue(fallback),
    };
    const resolver = new CategoryResolver(repo as CategoryRepository);

    const result = await resolver.resolve(['xyz'], TransactionType.EXPENSE, 'u1');
    expect(result).toBe(fallback);
    expect(repo.findByNameAndType).toHaveBeenCalledWith('Lainnya', TransactionType.EXPENSE, null);
  });

  it('uses the income fallback name for income', async () => {
    const repo: Partial<CategoryRepository> = {
      findByKeyword: jest.fn().mockResolvedValue(null),
      findByNameAndType: jest.fn().mockResolvedValue(null),
    };
    const resolver = new CategoryResolver(repo as CategoryRepository);

    await resolver.resolve([], TransactionType.INCOME, 'u1');
    expect(repo.findByNameAndType).toHaveBeenCalledWith(
      'Pemasukan Lain',
      TransactionType.INCOME,
      null,
    );
  });
});
