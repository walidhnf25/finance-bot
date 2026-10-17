import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { DEFAULT_TIMEZONE } from 'src/shared/utils/date.util';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

export interface DateMatch {
  date: Date;
  text: string;
  start: number;
  end: number;
}

/** ISO weekday numbers (Mon=1 .. Sun=7). */
const WEEKDAYS: Record<string, number> = {
  senin: 1,
  selasa: 2,
  rabu: 3,
  kamis: 4,
  jumat: 5,
  sabtu: 6,
  minggu: 7,
};

type Resolver = (now: dayjs.Dayjs, groups: string[]) => dayjs.Dayjs;

/** Noon in the reference timezone, N days back from `now`. */
function daysAgo(now: dayjs.Dayjs, n: number): dayjs.Dayjs {
  return now.subtract(n, 'day').hour(12).minute(0).second(0).millisecond(0);
}

/** Most recent past occurrence of an ISO weekday. */
function lastWeekday(now: dayjs.Dayjs, target: number, strictPast: boolean): dayjs.Dayjs {
  let diff = (now.isoWeekday() - target + 7) % 7;
  if (diff === 0 && strictPast) diff = 7;
  return now.subtract(diff, 'day').hour(12).minute(0).second(0).millisecond(0);
}

interface Pattern {
  re: RegExp;
  resolve: Resolver;
}

// Ordered by specificity (longer phrases first).
const PATTERNS: Pattern[] = [
  { re: /\bhari\s*ini\b/, resolve: (now) => now },
  { re: /\b(?:tadi|barusan|sekarang)\b/, resolve: (now) => now },
  { re: /\bkemarin\s+lusa\b/, resolve: (now) => daysAgo(now, 2) },
  { re: /\b(?:kemarin|kmrn|kmaren)\b/, resolve: (now) => daysAgo(now, 1) },
  { re: /\bbesok\b|\bbsk\b/, resolve: (now) => daysAgo(now, -1) },
  { re: /\blusa\b/, resolve: (now) => daysAgo(now, -2) },
  {
    re: /\b(\d+)\s*hari\s*(?:yang\s*)?(?:lalu|lampau)\b/,
    resolve: (now, g) => daysAgo(now, parseInt(g[1], 10)),
  },
  { re: /\b(?:minggu|pekan)\s+lalu\b/, resolve: (now) => daysAgo(now, 7) },
  {
    re: /\bbulan\s+lalu\b/,
    resolve: (now) => now.subtract(1, 'month').hour(12).minute(0).second(0),
  },
  {
    re: /\b(senin|selasa|rabu|kamis|jumat|sabtu|minggu)\s+(?:lalu|kemarin)\b/,
    resolve: (now, g) => lastWeekday(now, WEEKDAYS[g[1]], true),
  },
  {
    re: /\b(senin|selasa|rabu|kamis|jumat|sabtu)\b/,
    resolve: (now, g) => lastWeekday(now, WEEKDAYS[g[1]], false),
  },
];

/**
 * Detect a relative date phrase in `text`. Returns the resolved date (noon in
 * the given tz for past days; `now` for "today"/"tadi") and the matched span.
 */
export function extractDate(
  text: string,
  now: Date = new Date(),
  tz: string = DEFAULT_TIMEZONE,
): DateMatch | null {
  const haystack = text.toLowerCase();
  const reference = dayjs(now).tz(tz);

  let best: { match: RegExpMatchArray; resolve: Resolver } | null = null;
  for (const { re, resolve } of PATTERNS) {
    const m = haystack.match(re);
    if (m && m.index !== undefined) {
      if (best === null || m.index < (best.match.index ?? Infinity)) {
        best = { match: m, resolve };
      }
    }
  }

  if (!best) return null;

  const resolved = best.resolve(reference, Array.from(best.match));
  const start = best.match.index ?? 0;
  const matchedText = best.match[0];
  return {
    date: resolved.toDate(),
    text: matchedText,
    start,
    end: start + matchedText.length,
  };
}
