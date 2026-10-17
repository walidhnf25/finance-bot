import { DateRangeSpec, SummaryPeriod } from 'src/modules/parser/domain/parsed-intent';
import {
  DateRange,
  dayRange,
  formatDate,
  monthRange,
  toIsoDate,
  weekRange,
} from 'src/shared/utils/date.util';

export interface PeriodInfo {
  range: DateRange;
  label: string;
  /** Short slug for filenames, e.g. "hari-ini". */
  slug: string;
}

/** Build PeriodInfo from an explicit date range (custom "dari … sampai …"). */
export function customRangeInfo(range: DateRangeSpec, tz: string): PeriodInfo {
  return {
    range,
    label: `${formatDate(range.start, tz)} – ${formatDate(range.end, tz)}`,
    slug: `${toIsoDate(range.start, tz)}_${toIsoDate(range.end, tz)}`,
  };
}

/** Resolve a SummaryPeriod into a concrete date range + labels (tz-aware). */
export function resolvePeriod(period: SummaryPeriod, now: Date, tz: string): PeriodInfo {
  switch (period) {
    case SummaryPeriod.Day:
      return { range: dayRange(now, tz), label: 'Hari Ini', slug: 'hari-ini' };
    case SummaryPeriod.Week:
      return { range: weekRange(now, tz), label: 'Minggu Ini', slug: 'minggu-ini' };
    case SummaryPeriod.Month:
    default:
      return { range: monthRange(now, tz), label: 'Bulan Ini', slug: 'bulan-ini' };
  }
}
