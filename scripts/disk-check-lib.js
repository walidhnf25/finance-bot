/**
 * Pure logic of `npm run disk:check`: turn `df -Pk` output into a verdict. No I/O here (unit-tested in
 * src/ops/disk-check.spec.ts).
 *
 * Why it exists: when the volume under PostgreSQL fills up, PostgreSQL does not just return an error. In an
 * isolated simulation it hit "PANIC: could not write to file pg_wal ... No space left on device" and then
 * REFUSED TO START until space was freed. So the time to act is before the disk is full.
 */

/** `df -Pk <path>` (POSIX format, 1K blocks) -> bytes, or null when it cannot be read. */
function parseDf(output) {
  const line = String(output).trim().split('\n').slice(-1)[0] ?? '';
  const cols = line.trim().split(/\s+/);
  // Filesystem 1024-blocks Used Available Capacity Mounted-on
  if (cols.length < 6) return null;
  const total = Number(cols[1]) * 1024;
  const used = Number(cols[2]) * 1024;
  const free = Number(cols[3]) * 1024;
  if (![total, used, free].every(Number.isFinite) || total <= 0) return null;
  return { total, used, free, freePct: (free / total) * 100 };
}

const MB = 1024 * 1024;
/** The percent limits apply only while less than this much is free. */
const PCT_APPLIES_BELOW_MB = 20 * 1024;

/**
 * @param {{total:number,free:number,freePct:number}|null} usage
 * @param {{warnMb:number,failMb:number,warnPct:number,failPct:number}} limits
 * @returns {'ok'|'warn'|'fail'|'unknown'}
 */
function judge(usage, limits) {
  if (!usage) return 'unknown';
  const freeMb = usage.free / MB;
  // A percentage only matters on a small volume: 12 % of a 235 GB disk is still 28 GB.
  const pctApplies = freeMb < PCT_APPLIES_BELOW_MB;
  if (freeMb < limits.failMb || (pctApplies && usage.freePct < limits.failPct)) return 'fail';
  if (freeMb < limits.warnMb || (pctApplies && usage.freePct < limits.warnPct)) return 'warn';
  return 'ok';
}

const DEFAULT_LIMITS = { warnMb: 2048, failMb: 512, warnPct: 15, failPct: 5 };

module.exports = { parseDf, judge, DEFAULT_LIMITS };
