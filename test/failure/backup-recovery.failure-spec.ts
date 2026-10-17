/**
 * Backups and restores under failure, with the REAL scripts (scripts/backup-db.sh, restore-rehearsal.sh) run
 * from an isolated copy of the scripts folder against a throw-away PostgreSQL that holds the real schema and
 * a little data. Nothing here touches `backups/` of the project, `finance-bot-postgres`, or any passphrase of
 * yours: a random test passphrase is generated for each run.
 *
 * A backup is only worth what survives these: a database that stops mid-dump, a full disk, a wrong
 * passphrase, a damaged file, a stale half-written file lying around.
 *
 * Needs Docker, GnuPG and bash (Git Bash on Windows):   npm run test:failure
 */
import { PrismaClient } from '@prisma/client';
import { ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docker, Disposable, DisposablePostgres, sleep, startDisposablePostgres } from './docker';

const BASH =
  [process.env.FINANCE_BOT_BASH, 'C:/Program Files/Git/bin/bash.exe', '/bin/bash']
    .filter((p): p is string => !!p)
    .find((p) => existsSync(p)) ?? 'bash';

describe('backup and restore under failure (real scripts, throw-away database)', () => {
  let pg: DisposablePostgres;
  let work: string;
  let secrets: string;
  let passFile: string;

  const run = (script: string, args: string[] = [], env: Record<string, string> = {}) =>
    spawnSync(BASH, [`scripts/${script}`, ...args], {
      cwd: work,
      encoding: 'utf8',
      timeout: 240_000,
      env: {
        ...process.env,
        MSYS_NO_PATHCONV: '1',
        FINANCE_BOT_DB_CONTAINER: pg.name,
        FINANCE_BOT_BACKUP_PASSPHRASE_FILE: passFile,
        ...env,
      },
    });
  const backupsDir = () => join(work, 'backups', 'db');
  const listing = () => (existsSync(backupsDir()) ? readdirSync(backupsDir()).sort() : []);
  const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

  beforeAll(async () => {
    pg = await startDisposablePostgres({ user: 'finance_bot', db: 'finance_bot' });
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: pg.url },
      stdio: 'ignore',
      shell: true,
    });
    const prisma = new PrismaClient({ datasources: { db: { url: pg.url } } });
    try {
      const user = await prisma.user.create({
        data: { telegramId: '4242', chatId: '4242', displayName: 'tester' },
      });
      for (let i = 0; i < 25; i += 1) {
        await prisma.transaction.create({
          data: {
            userId: user.id,
            type: 'EXPENSE',
            amountMinor: BigInt(10_000 + i) * 100n,
            description: `item ${i}`,
            occurredAt: new Date('2026-07-15T05:00:00Z'),
            idempotencyKey: `seed-${i}`,
          },
        });
      }
    } finally {
      await prisma.$disconnect();
    }

    work = mkdtempSync(join(tmpdir(), 'finance-bot-fi-backup-'));
    secrets = mkdtempSync(join(tmpdir(), 'finance-bot-fi-secret-'));
    cpSync(join(process.cwd(), 'scripts'), join(work, 'scripts'), { recursive: true });
    passFile = join(secrets, 'passphrase');
    writeFileSync(passFile, `${randomBytes(18).toString('hex')}\n`, { mode: 0o600 });
  });
  afterAll(() => {
    (pg as Disposable | undefined)?.remove();
    for (const dir of [work, secrets]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes an encrypted, checksummed, read-back backup and leaves no partial file', () => {
    const r = run('backup-db.sh', ['fi']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Verified: it decrypts and lists as a valid PostgreSQL dump.');
    const files = listing();
    expect(files.filter((f) => f.endsWith('.dump.gpg'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.sha256'))).toHaveLength(1);
    expect(files.some((f) => f.endsWith('.part'))).toBe(false);
    const dump = join(
      backupsDir(),
      files.find((f) => f.endsWith('.dump.gpg'))!,
    );
    // encrypted: GnuPG packet, not the PGDMP header of a plain pg_dump
    expect(readFileSync(dump).subarray(0, 5).toString('latin1')).not.toBe('PGDMP');
    expect(readFileSync(`${dump}.sha256`, 'utf8').split(' ')[0]).toBe(sha(dump));
  });

  const danglingVolumes = () =>
    docker(['volume', 'ls', '-q', '-f', 'dangling=true'])
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean)
      .sort();

  it('proves the backup restores: a throw-away copy MATCHES the source and is removed afterwards, WITHOUT leaving a volume that holds a plaintext copy', () => {
    const volumesBefore = danglingVolumes();
    const r = run('restore-rehearsal.sh');
    expect(danglingVolumes()).toEqual(volumesBefore); // no orphaned volume with the restored data
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('integrity checks on the restored copy: all passed');
    expect(r.stdout).toContain('MATCHES the live database');
    const leftovers = docker([
      'ps',
      '-a',
      '--filter',
      'label=finance-bot.rehearsal=true',
      '-q',
    ]).trim();
    expect(leftovers).toBe('');
  });

  it('the integrity gate passes on good data and can NEVER pass when the checks did not run', () => {
    const ok = run('verify-integrity.sh');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('all integrity checks passed');
    const bad = run('verify-integrity.sh', ['no_such_database']);
    expect(bad.status).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`).not.toContain('all integrity checks passed');
    // a damaged checks file (fewer rows than expected) is refused too
    const broken = join(work, 'scripts', 'sql', 'integrity-checks.sql');
    const original = readFileSync(broken, 'utf8');
    try {
      writeFileSync(broken, "SELECT 'only one check|' || 0;\n");
      const partial = run('verify-integrity.sh');
      expect(partial.status).not.toBe(0);
      expect(`${partial.stdout}${partial.stderr}`).not.toContain('all integrity checks passed');
    } finally {
      writeFileSync(broken, original);
    }
  });

  it('refuses a wrong passphrase, and cleans up its container', () => {
    const wrong = join(secrets, 'wrong');
    writeFileSync(wrong, 'definitely-not-it\n', { mode: 0o600 });
    const r = run('restore-rehearsal.sh', [], { FINANCE_BOT_BACKUP_PASSPHRASE_FILE: wrong });
    expect(r.status).not.toBe(0);
    expect(docker(['ps', '-a', '--filter', 'label=finance-bot.rehearsal=true', '-q']).trim()).toBe(
      '',
    );
  });

  it('refuses a damaged file (checksum mismatch) before touching anything', () => {
    const copy = join(backupsDir(), 'finance-bot-damaged-20260101T000000Z.dump.gpg');
    const good = readdirSync(backupsDir()).find((f) => f.endsWith('.dump.gpg'))!;
    const bytes = readFileSync(join(backupsDir(), good));
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(copy, bytes);
    writeFileSync(`${copy}.sha256`, readFileSync(join(backupsDir(), `${good}.sha256`)));
    const r = run('restore-rehearsal.sh', [copy.replace(work, '.').replace(/\\/g, '/')]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('Checksum mismatch');
    rmSync(copy, { force: true }); // the other tests use "the newest backup"
    rmSync(`${copy}.sha256`, { force: true });
  });

  it('rotation keeps the newest N per label, never touches other labels, and a failed backup deletes nothing', () => {
    const labelled = (label: string) =>
      listing().filter((f) => f.startsWith(`finance-bot-${label}-`) && f.endsWith('.dump.gpg'));
    const otherBefore = listing().filter((f) => f.startsWith('finance-bot-fi-'));
    expect(otherBefore.length).toBeGreaterThan(0); // there IS another label to protect
    const created: string[] = []; // in creation order
    for (let i = 0; i < 3; i += 1) {
      const r = run('backup-db.sh', ['rot'], { FINANCE_BOT_BACKUP_KEEP: '2' });
      expect(r.status).toBe(0);
      const fresh = labelled('rot').filter((f) => !created.includes(f));
      expect(fresh).toHaveLength(1);
      created.push(fresh[0]);
    }
    expect(created).toEqual([...created].sort()); // names carry a UTC timestamp: creation order = name order
    // exactly the NEWEST two survive; the oldest is gone together with its checksum
    expect(labelled('rot')).toEqual(created.slice(-2));
    expect(listing()).not.toContain(created[0]);
    expect(listing()).not.toContain(`${created[0]}.sha256`);
    for (const k of created.slice(-2)) expect(listing()).toContain(`${k}.sha256`);
    // another label is untouched
    expect(listing().filter((f) => otherBefore.includes(f))).toEqual(otherBefore);
    // a backup that FAILS (here: the passphrase file is missing) deletes nothing, even with KEEP=1
    const failed = run('backup-db.sh', ['rot'], {
      FINANCE_BOT_BACKUP_KEEP: '1',
      FINANCE_BOT_BACKUP_PASSPHRASE_FILE: join(secrets, 'does-not-exist'),
    });
    expect(failed.status).not.toBe(0);
    expect(labelled('rot')).toEqual(created.slice(-2));
  });

  it('a stale half-written .part file is never mistaken for a backup', () => {
    writeFileSync(
      join(backupsDir(), 'finance-bot-zzz-99999999T999999Z.dump.gpg.part'),
      randomBytes(2048),
    );
    const r = run('restore-rehearsal.sh');
    expect(r.status).toBe(0); // it picked the newest REAL backup, not the newer-looking .part
    expect(r.stdout).toContain('MATCHES the live database');
  });

  it('an interrupted backup (database stops mid-dump) fails loudly and leaves no file and no .part', async () => {
    // make the dump long enough to interrupt: ~100 MB of incompressible data
    pg.run(
      "CREATE TABLE filler AS SELECT (SELECT string_agg(md5(random()::text),'') FROM generate_series(1,60)) AS x FROM generate_series(1,150000)",
    );
    const before = listing().filter((f) => f.endsWith('.dump.gpg'));
    const goodFile = join(
      backupsDir(),
      before.find((f) => !f.includes('damaged'))!,
    );
    const goodHash = sha(goodFile);

    const child: ChildProcess = spawn(BASH, ['scripts/backup-db.sh', 'fi2'], {
      cwd: work,
      env: {
        ...process.env,
        MSYS_NO_PATHCONV: '1',
        FINANCE_BOT_DB_CONTAINER: pg.name,
        FINANCE_BOT_BACKUP_PASSPHRASE_FILE: passFile,
      },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    // wait until the encrypted stream is really being written, then pull the database away mid-dump
    const streaming = Date.now() + 60_000;
    while (
      Date.now() < streaming &&
      !listing().some((f) => f.includes('fi2') && f.endsWith('.part'))
    ) {
      await sleep(25);
    }
    expect(listing().some((f) => f.includes('fi2') && f.endsWith('.part'))).toBe(true);
    pg.stop(); // the database goes away in the middle of pg_dump
    const code = await exited;

    expect(code).not.toBe(0);
    const after = listing();
    expect(after.some((f) => f.includes('fi2'))).toBe(false); // neither a final file nor a .part
    expect(sha(goodFile)).toBe(goodHash); // the earlier backup is untouched

    pg.start();
    pg.run('DROP TABLE filler');
  });

  it('a full disk during a backup fails loudly, keeps the old backup, and leaves no half file (Linux container, 8 KB volume)', () => {
    const name = `finance-bot-fi-linux-${randomBytes(3).toString('hex')}`;
    const script = [
      'set -u',
      'apk add -q --no-progress bash gnupg coreutils >/dev/null 2>&1 || { echo APK_FAILED; exit 99; }',
      'mkdir -p /work && cp -r /scripts-src /work/scripts && cd /work && mkdir -p backups/db',
      'echo OLD-GOOD-BACKUP > backups/db/finance-bot-fi3-20200101T000000Z.dump.gpg',
      'FINANCE_BOT_BACKUP_MIN_FREE_MB=0 bash scripts/backup-db.sh fi3; echo "backup-exit=$?"',
      'bash scripts/backup-db.sh fi3 2>&1 | grep -c "MB free where backups are written" | sed "s/^/preflight-hits=/"',
      'ls -1 backups/db; echo "old=$(cat backups/db/finance-bot-fi3-20200101T000000Z.dump.gpg)"',
    ].join('\n');
    try {
      docker([
        'create',
        '--name',
        name,
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        '--tmpfs',
        '/work/backups/db:rw,size=8k',
        '-e',
        `FINANCE_BOT_DB_CONTAINER=${pg.name}`,
        '-e',
        'FINANCE_BOT_BACKUP_PASSPHRASE_FILE=/secrets/passphrase',
        'docker:cli',
        'sh',
        '-c',
        script,
      ]);
      docker(['cp', join(work, 'scripts'), `${name}:/scripts-src`]);
      mkdirSync(join(secrets, 'for-linux'), { recursive: true });
      writeFileSync(join(secrets, 'for-linux', 'passphrase'), readFileSync(passFile));
      docker(['cp', join(secrets, 'for-linux'), `${name}:/secrets`]);
      const out = docker(['start', '-a', name]);
      expect(out).not.toContain('APK_FAILED');
      expect(out).toMatch(/backup-exit=[1-9]/); // it failed, loudly
      expect(out).toContain('preflight-hits=1'); // and by default it refuses to even start on a nearly full disk
      expect(out).toContain('old=OLD-GOOD-BACKUP'); // the previous backup was not touched
      expect(out).not.toMatch(/\.part/); // and no half-written file remains
      expect(out).not.toMatch(/finance-bot-fi3-2026/); // no new "backup" appeared
    } finally {
      try {
        docker(['rm', '-f', '-v', name]);
      } catch {
        /* gone */
      }
    }
  });
});
