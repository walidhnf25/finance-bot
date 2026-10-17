// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../scripts/disk-check-lib.js') as {
  parseDf: (o: string) => { total: number; used: number; free: number; freePct: number } | null;
  judge: (u: unknown, l: unknown) => 'ok' | 'warn' | 'fail' | 'unknown';
  DEFAULT_LIMITS: { warnMb: number; failMb: number; warnPct: number; failPct: number };
};

const df = (totalKb: number, usedKb: number, freeKb: number) =>
  `Filesystem     1024-blocks      Used Available Capacity Mounted on\noverlay        ${totalKb} ${usedKb} ${freeKb}  50% /var/lib/postgresql/data\n`;
const GB = 1024 * 1024; // in KB

describe('disk-check', () => {
  it('reads POSIX df output', () => {
    const u = lib.parseDf(df(100 * GB, 40 * GB, 60 * GB));
    expect(u?.free).toBe(60 * GB * 1024);
    expect(Math.round(u?.freePct ?? 0)).toBe(60);
  });

  it.each(['', 'garbage', 'Filesystem only one line\n', df(0, 0, 0)])(
    'refuses to guess from unreadable output %j',
    (out) => expect(lib.parseDf(out)).toBeNull(),
  );

  it.each([
    [100 * GB, 60 * GB, 'ok'],
    [100 * GB, 10 * GB, 'warn'], // 10 % free
    [100 * GB, 1 * GB, 'fail'], // 1 % free
    [10 * GB, 1.5 * GB, 'warn'], // 15 % and 1.5 GB: under 2 GB
    [1000 * GB, 400, 'fail'], // under 512 MB whatever the percentage
    [10 * GB, 1.9 * GB, 'warn'], // 19 % free, but under 2 GB
    [235 * GB, 27.7 * GB, 'ok'], // 12 % of a big disk is still 28 GB: no alarm
    [235 * GB, 12 * GB, 'warn'], // 5 % and under 20 GB: the percentage now counts
    [235 * GB, 4 * GB, 'fail'], // under 5 % and under 20 GB
  ])('judges %d KB total with %d KB free as %s', (total, free, expected) => {
    expect(lib.judge(lib.parseDf(df(total, total - free, free)), lib.DEFAULT_LIMITS)).toBe(
      expected,
    );
  });

  it('is unknown, never "ok", when it could not measure', () => {
    expect(lib.judge(null, lib.DEFAULT_LIMITS)).toBe('unknown');
  });
});
