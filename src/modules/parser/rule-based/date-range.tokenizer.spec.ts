import { toIsoDate } from 'src/shared/utils/date.util';
import { extractDateRange } from './date-range.tokenizer';

const TZ = 'Asia/Jakarta';
const NOW = new Date('2026-07-13T03:00:00.000Z');

function iso(text: string): { start: string; end: string } | null {
  const r = extractDateRange(text, NOW, TZ);
  return r ? { start: toIsoDate(r.start, TZ), end: toIsoDate(r.end, TZ) } : null;
}

describe('extractDateRange', () => {
  it('parses "dari 13 juli sampai 14 juli 2026"', () => {
    expect(iso('ringkasan dari 13 juli sampai 14 juli 2026')).toEqual({
      start: '2026-07-13',
      end: '2026-07-14',
    });
  });

  it('parses numeric dates with s/d', () => {
    expect(iso('export dari 13/07/2026 s/d 14/07/2026')).toEqual({
      start: '2026-07-13',
      end: '2026-07-14',
    });
  });

  it('parses a spaced dash separator without confusing date dashes', () => {
    expect(iso('ringkasan 13/07/2026 - 14/07/2026')).toEqual({
      start: '2026-07-13',
      end: '2026-07-14',
    });
    expect(iso('export 13-07-2026 - 14-07-2026')).toEqual({
      start: '2026-07-13',
      end: '2026-07-14',
    });
  });

  it('inherits the year from the other date', () => {
    expect(iso('13 juli sampai 20 juli 2026')).toEqual({ start: '2026-07-13', end: '2026-07-20' });
  });

  it('defaults to the current year when none given', () => {
    expect(iso('1 juni hingga 30 juni')).toEqual({ start: '2026-06-01', end: '2026-06-30' });
  });

  it('produces inclusive day boundaries', () => {
    const r = extractDateRange('dari 13 juli sampai 14 juli 2026', NOW, TZ)!;
    expect(r.start.toISOString()).toBe('2026-07-12T17:00:00.000Z'); // 13 Jul 00:00 WIB
    expect(r.end.toISOString()).toBe('2026-07-14T16:59:59.999Z'); // 14 Jul 23:59 WIB
  });

  it('returns null without a range keyword', () => {
    expect(extractDateRange('ringkasan bulan ini', NOW, TZ)).toBeNull();
    expect(extractDateRange('ringkasan 13 juli 2026', NOW, TZ)).toBeNull();
  });

  it('returns null when the end is before the start', () => {
    expect(extractDateRange('dari 14 juli sampai 13 juli 2026', NOW, TZ)).toBeNull();
  });
});
