import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { DEFAULT_TIMEZONE } from 'src/shared/utils/date.util';
import { normalizeText } from 'src/shared/utils/string-normalizer';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export interface AbsoluteRange {
  start: Date;
  end: Date;
}

const MONTHS: Record<string, number> = {
  januari: 1,
  jan: 1,
  februari: 2,
  feb: 2,
  pebruari: 2,
  maret: 3,
  mar: 3,
  april: 4,
  apr: 4,
  mei: 5,
  juni: 6,
  jun: 6,
  juli: 7,
  jul: 7,
  agustus: 8,
  agu: 8,
  agt: 8,
  ags: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  oktober: 10,
  okt: 10,
  oct: 10,
  november: 11,
  nov: 11,
  desember: 12,
  des: 12,
  dec: 12,
};

// Range separators. A dash/en-dash is only treated as a separator when
// surrounded by spaces, so it isn't confused with a dash inside "13-07-2026".
const RANGE_SEP = /\s+(?:sampai dengan|sampai|hingga|s\/d|s\.d|\bsd\b|-|–|—)\s+/;

interface DateParts {
  day: number;
  month: number;
  year: number | null;
}

const pad = (n: number): string => n.toString().padStart(2, '0');

function parseDatePart(input: string): DateParts | null {
  const s = input.trim();

  // "13 juli 2026" / "13 jul"
  const named = s.match(/(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?/);
  if (named) {
    const month = MONTHS[named[2]];
    if (month) {
      return { day: parseInt(named[1], 10), month, year: named[3] ? parseInt(named[3], 10) : null };
    }
  }

  // "13/07/2026" / "13-7" / "13.07.26"
  const numeric = s.match(/(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?/);
  if (numeric) {
    let year = numeric[3] ? parseInt(numeric[3], 10) : null;
    if (year !== null && year < 100) year += 2000;
    return { day: parseInt(numeric[1], 10), month: parseInt(numeric[2], 10), year };
  }

  return null;
}

function buildDay(
  year: number,
  month: number,
  day: number,
  tz: string,
  boundary: 'start' | 'end',
): Date | null {
  const d = dayjs.tz(`${year}-${pad(month)}-${pad(day)}`, 'YYYY-MM-DD', tz);
  if (!d.isValid()) return null;
  return (boundary === 'start' ? d.startOf('day') : d.endOf('day')).toDate();
}

/**
 * Extract an explicit date range, e.g. "dari 13 juli sampai 14 juli 2026" or
 * "13/07/2026 s/d 14/07/2026". Requires a range keyword (sampai/hingga/sd/s/d).
 * A missing year is inherited from the other date, then the current year.
 */
export function extractDateRange(
  text: string,
  now: Date = new Date(),
  tz: string = DEFAULT_TIMEZONE,
): AbsoluteRange | null {
  const normalized = normalizeText(text);
  const parts = normalized.split(RANGE_SEP);
  if (parts.length < 2) return null;

  const left = parseDatePart(parts[0]);
  const right = parseDatePart(parts[1]);
  if (!left || !right) return null;

  const currentYear = dayjs(now).tz(tz).year();
  const endYear = right.year ?? left.year ?? currentYear;
  const startYear = left.year ?? endYear;

  const start = buildDay(startYear, left.month, left.day, tz, 'start');
  const end = buildDay(endYear, right.month, right.day, tz, 'end');
  if (!start || !end || end.getTime() < start.getTime()) return null;

  return { start, end };
}
