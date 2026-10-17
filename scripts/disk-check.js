#!/usr/bin/env node
/**
 * Read-only look at the free space that matters to your data:
 *   - the volume under PostgreSQL (measured INSIDE the container, so it is the volume Docker really uses), and
 *   - the folder where backups are written.
 *
 *   npm run disk:check
 *
 * Exit 0 = both fine, 1 = a volume is below the WARN or FAIL limit, 2 = cannot measure (and nothing else is wrong).
 * Limits (override with env, numbers only): DISK_WARN_MB=2048 DISK_FAIL_MB=512 DISK_WARN_PCT=15 DISK_FAIL_PCT=5.
 * Run it before big imports and from time to time; PostgreSQL does not fail gracefully on a full disk.
 */
require('dotenv/config');
const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { parseDf, judge, DEFAULT_LIMITS } = require('./disk-check-lib');

/** A limit from the environment must be a plain non-negative number: a typo ("512MB") must not silently switch the check off. */
const limit = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`${name} must be a plain non-negative number (got "${raw}")`);
    process.exit(2);
  }
  return n;
};
const limits = {
  warnMb: limit('DISK_WARN_MB', DEFAULT_LIMITS.warnMb),
  failMb: limit('DISK_FAIL_MB', DEFAULT_LIMITS.failMb),
  warnPct: limit('DISK_WARN_PCT', DEFAULT_LIMITS.warnPct),
  failPct: limit('DISK_FAIL_PCT', DEFAULT_LIMITS.failPct),
};
const container = process.env.FINANCE_BOT_DB_CONTAINER || 'finance-bot-postgres';
const backups = path.join(__dirname, '..', 'backups', 'db');

const run = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });

const targets = [];
try {
  targets.push({
    label: `PostgreSQL volume (${container}:/var/lib/postgresql/data)`,
    usage: parseDf(run('docker', ['exec', container, 'df', '-Pk', '/var/lib/postgresql/data'])),
  });
} catch {
  targets.push({ label: `PostgreSQL volume (${container})`, usage: null });
}
try {
  mkdirSync(backups, { recursive: true });
  targets.push({
    label: 'backups folder (backups/db)',
    usage: parseDf(run('df', ['-Pk', backups])),
  });
} catch {
  targets.push({ label: 'backups folder (backups/db)', usage: null });
}

const verdicts = targets.map((t) => judge(t.usage, limits));
targets.forEach((t, i) => {
  const free = t.usage
    ? `${(t.usage.free / 1024 ** 3).toFixed(1)} GB free (${t.usage.freePct.toFixed(0)} %)`
    : 'cannot measure';
  console.log(`${verdicts[i].toUpperCase().padEnd(7)} ${t.label}: ${free}`);
});

// A real shortage always wins over "could not measure the other one".
if (verdicts.includes('fail') || verdicts.includes('warn')) {
  console.error(
    '\nFree some space before PostgreSQL has to refuse writes: old backups (backups/db), `docker image prune`, logs.\n' +
      'A completely full volume makes PostgreSQL PANIC and refuse to start (docs/runbook.md, "Disk penuh").',
  );
  process.exit(1);
}
if (verdicts.includes('unknown')) {
  console.error(
    '\ncould not measure every volume (is Docker running? is the database container up?)',
  );
  process.exit(2);
}
console.log('\ndisk space is fine');
process.exit(0);
