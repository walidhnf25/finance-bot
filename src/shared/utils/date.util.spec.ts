import { dayRange, formatDate, monthRange, toIsoDate, weekRange } from './date.util';

const TZ = 'Asia/Jakarta';

describe('date.util', () => {
  // Reference: Sunday 2026-07-12 10:00 UTC = 17:00 WIB (Asia/Jakarta, UTC+7)
  const ref = '2026-07-12T10:00:00.000Z';

  describe('dayRange', () => {
    it('spans local midnight to end-of-day in the tz', () => {
      const { start, end } = dayRange(ref, TZ);
      // 2026-07-12 00:00 WIB === 2026-07-11 17:00 UTC
      expect(start.toISOString()).toBe('2026-07-11T17:00:00.000Z');
      expect(end.toISOString()).toBe('2026-07-12T16:59:59.999Z');
    });
  });

  describe('weekRange (ISO week, Monday start)', () => {
    it('starts on Monday of the containing week', () => {
      const { start, end } = weekRange(ref, TZ);
      // Monday 2026-07-06 00:00 WIB === 2026-07-05 17:00 UTC
      expect(start.toISOString()).toBe('2026-07-05T17:00:00.000Z');
      // Sunday 2026-07-12 23:59:59.999 WIB === 2026-07-12 16:59:59.999 UTC
      expect(end.toISOString()).toBe('2026-07-12T16:59:59.999Z');
    });
  });

  describe('monthRange', () => {
    it('spans the whole calendar month in the tz', () => {
      const { start, end } = monthRange(ref, TZ);
      // 2026-07-01 00:00 WIB === 2026-06-30 17:00 UTC
      expect(start.toISOString()).toBe('2026-06-30T17:00:00.000Z');
      // 2026-07-31 23:59:59.999 WIB === 2026-07-31 16:59:59.999 UTC
      expect(end.toISOString()).toBe('2026-07-31T16:59:59.999Z');
    });
  });

  describe('formatting', () => {
    it('formats DD/MM/YYYY in tz', () => {
      expect(formatDate(ref, TZ)).toBe('12/07/2026');
    });
    it('formats ISO date in tz', () => {
      expect(toIsoDate(ref, TZ)).toBe('2026-07-12');
    });
  });
});
