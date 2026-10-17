import { BudgetPeriod } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';

/** A budget threshold crossing detected after recording an expense. */
export interface BudgetAlert {
  /** Category name, or "Keseluruhan" for an overall budget. */
  categoryName: string;
  period: BudgetPeriod;
  used: Money;
  limit: Money;
  percent: number;
  /** True when usage has reached or exceeded 100%. */
  exceeded: boolean;
}
