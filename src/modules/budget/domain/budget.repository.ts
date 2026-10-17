import { BudgetPeriod } from 'src/shared/domain/enums';
import { BudgetEntity, UpsertBudgetInput } from './budget.entity';

export abstract class BudgetRepository {
  /** Create or replace the budget for (user, category, period). */
  abstract upsert(input: UpsertBudgetInput): Promise<BudgetEntity>;

  abstract findForUser(userId: string): Promise<BudgetEntity[]>;

  abstract findByCategoryPeriod(
    userId: string,
    categoryId: string | null,
    period: BudgetPeriod,
  ): Promise<BudgetEntity | null>;

  /** Removes the user's budget; a no-op when it does not exist or belongs to someone else. */
  abstract delete(userId: string, id: string): Promise<void>;
}
