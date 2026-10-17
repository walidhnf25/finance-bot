import { toIsoDate } from 'src/shared/utils/date.util';
import { extractDate } from './date.tokenizer';

const TZ = 'Asia/Jakarta';
// Wednesday 2026-07-15, 10:00 WIB (03:00 UTC).
const NOW = new Date('2026-07-15T03:00:00.000Z');

function isoOf(text: string): string | null {
  const match = extractDate(text, NOW, TZ);
  return match ? toIsoDate(match.date, TZ) : null;
}

describe('extractDate', () => {
  it.each([
    ['beli kopi hari ini', '2026-07-15'],
    ['jajan kemarin', '2026-07-14'],
    ['makan kemarin lusa', '2026-07-13'],
    ['bayar 3 hari lalu', '2026-07-12'],
    ['nonton minggu lalu', '2026-07-08'],
    ['kopi senin lalu', '2026-07-13'],
    ['bakso senin', '2026-07-13'],
    ['isi bensin besok', '2026-07-16'],
  ])('resolves the date in "%s" -> %s', (text, expected) => {
    expect(isoOf(text)).toBe(expected);
  });

  it('returns null when no date phrase is present', () => {
    expect(extractDate('beli kopi 25rb', NOW, TZ)).toBeNull();
  });

  it('reports the matched span', () => {
    const match = extractDate('jajan kemarin', NOW, TZ);
    expect(match?.text).toBe('kemarin');
  });
});
