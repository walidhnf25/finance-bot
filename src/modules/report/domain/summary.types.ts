import { DateRange } from 'src/shared/utils/date.util';
import { Money } from 'src/shared/utils/money';

export interface CategoryBreakdown {
  name: string;
  icon: string;
  total: Money;
}

export interface SummaryResult {
  /** Human label, e.g. "Hari Ini" / "Minggu Ini" / "Bulan Ini". */
  periodLabel: string;
  range: DateRange;
  income: Money;
  expense: Money;
  balance: Money;
  /** Expense breakdown per category, largest first. */
  categories: CategoryBreakdown[];
}
