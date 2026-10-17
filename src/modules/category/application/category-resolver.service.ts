import { Injectable } from '@nestjs/common';
import { TransactionType } from 'src/shared/domain/enums';
import { CategoryEntity } from '../domain/category.entity';
import { CategoryRepository } from '../domain/category.repository';

/** Default category names used when no keyword matches. Seeded by CategorySeederService. */
const FALLBACK_NAME: Record<TransactionType, string> = {
  [TransactionType.EXPENSE]: 'Lainnya',
  [TransactionType.INCOME]: 'Pemasukan Lain',
};

/**
 * Turns the parser's candidate keywords into a concrete {@link CategoryEntity}.
 * Tries each keyword (most specific first) against the keyword index, then
 * falls back to the type's default category.
 */
@Injectable()
export class CategoryResolver {
  constructor(private readonly categories: CategoryRepository) {}

  async resolve(
    keywords: string[],
    type: TransactionType,
    userId: string,
  ): Promise<CategoryEntity | null> {
    for (const keyword of keywords) {
      const match = await this.categories.findByKeyword(keyword, { type, userId });
      if (match) return match;
    }
    return this.categories.findByNameAndType(FALLBACK_NAME[type], type, null);
  }
}
