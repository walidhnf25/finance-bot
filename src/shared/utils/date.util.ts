import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

export const DEFAULT_TIMEZONE = 'Asia/Jakarta';

export interface DateRange {
  /** Inclusive start instant (UTC Date). */
  start: Date;
  /** Inclusive end instant (UTC Date). */
  end: Date;
}

type DateInput = Date | string | number;

/** Current instant, interpreted in the given timezone. */
export function nowInTz(tz: string = DEFAULT_TIMEZONE): dayjs.Dayjs {
  return dayjs().tz(tz);
}

/** [00:00:00.000, 23:59:59.999] of the reference day, in `tz`. */
export function dayRange(ref: DateInput = new Date(), tz: string = DEFAULT_TIMEZONE): DateRange {
  const d = dayjs(ref).tz(tz);
  return { start: d.startOf('day').toDate(), end: d.endOf('day').toDate() };
}

/** ISO week (Monday–Sunday) containing the reference date, in `tz`. */
export function weekRange(ref: DateInput = new Date(), tz: string = DEFAULT_TIMEZONE): DateRange {
  const d = dayjs(ref).tz(tz);
  return { start: d.startOf('isoWeek').toDate(), end: d.endOf('isoWeek').toDate() };
}

/** Calendar month containing the reference date, in `tz`. */
export function monthRange(ref: DateInput = new Date(), tz: string = DEFAULT_TIMEZONE): DateRange {
  const d = dayjs(ref).tz(tz);
  return { start: d.startOf('month').toDate(), end: d.endOf('month').toDate() };
}

/** Format a date for display in `tz`, default `DD/MM/YYYY`. */
export function formatDate(
  ref: DateInput,
  tz: string = DEFAULT_TIMEZONE,
  pattern = 'DD/MM/YYYY',
): string {
  return dayjs(ref).tz(tz).format(pattern);
}

/** Human month label, e.g. "Juli 2026" is left to the report layer; this gives ISO. */
export function toIsoDate(ref: DateInput, tz: string = DEFAULT_TIMEZONE): string {
  return dayjs(ref).tz(tz).format('YYYY-MM-DD');
}
