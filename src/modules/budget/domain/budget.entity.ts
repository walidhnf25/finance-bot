import { BudgetPeriod } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';

export interface BudgetEntity {
  id: string;
  userId: string;
  /** null => overall budget (not tied to a category). */
  categoryId: string | null;
  amount: Money;
  period: BudgetPeriod;
  alertThreshold: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertBudgetInput {
  userId: string;
  categoryId?: string | null;
  amount: Money;
  period: BudgetPeriod;
  alertThreshold?: number;
}
