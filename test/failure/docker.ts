/**
 * Helpers for FAILURE-INJECTION tests: throw-away Docker containers that these tests may stop, kill and
 * restart at will. They never touch `finance-bot-postgres` (your data) or the compose Redis: every container
 * here has its own random name, its own port and no volume.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const docker = (args: string[], input?: string): string =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Git Bash must not rewrite /var/... into C:/Program Files/Git/var/...
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Disposable {
  name: string;
  port: number;
  stop(): void;
  start(): void;
  kill(): void;
  remove(): void;
}

const handle = (name: string, port: number): Disposable => ({
  name,
  port,
  stop: () => void docker(['stop', '-t', '2', name]),
  start: () => void docker(['start', name]),
  kill: () => void docker(['kill', name]),
  remove: () => {
    try {
      docker(['rm', '-f', '-v', name]);
    } catch {
      /* already gone */
    }
  },
});

const suffix = () => randomBytes(3).toString('hex');

export const freePort = (base: number): number => base + Math.floor(Math.random() * 400);

export async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error('condition not reached in time');
}

export interface DisposablePostgres extends Disposable {
  url: string;
  password: string;
  user: string;
  db: string;
  /** Runs one SQL statement through psql inside the container and returns its output. */
  run(sql: string): string;
}

/** A PostgreSQL 16 that exists only for one test file. */
export async function startDisposablePostgres(
  options: { user?: string; db?: string } = {},
): Promise<DisposablePostgres> {
  const user = options.user ?? 'fi';
  const db = options.db ?? 'finance_bot_test';
  const name = `finance-bot-fi-pg-${suffix()}`;
  const port = freePort(15500);
  const password = randomBytes(9).toString('hex');
  docker([
    'run',
    '-d',
    '--name',
    name,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    `POSTGRES_USER=${user}`,
    '-e',
    `POSTGRES_DB=${db}`,
    '-p',
    `127.0.0.1:${port}:5432`,
    'postgres:16-alpine',
  ]);
  const run = (sql: string) => docker(['exec', name, 'psql', '-U', user, '-d', db, '-tAc', sql]);
  await waitFor(() => {
    try {
      docker(['exec', name, 'pg_isready', '-U', user, '-d', db]);
      run('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }, 60_000);
  // the official image restarts once while initialising; wait for a stable answer
  await sleep(2_000);
  await waitFor(() => {
    try {
      run('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }, 30_000);
  return {
    ...handle(name, port),
    password,
    user,
    db,
    run,
    url: `postgresql://${user}:${password}@127.0.0.1:${port}/${db}?schema=public`,
  };
}

/** A Redis that exists only for one test file. `aof` = the same persistence the compose service uses. */
export async function startDisposableRedis(
  options: { aof?: boolean } = {},
): Promise<Disposable & { url: string }> {
  const name = `finance-bot-fi-redis-${suffix()}`;
  const port = freePort(16500);
  docker([
    'run',
    '-d',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:6379`,
    'redis:7-alpine',
    'redis-server',
    '--maxmemory',
    '64mb',
    '--maxmemory-policy',
    'noeviction',
    '--appendonly',
    options.aof ? 'yes' : 'no',
    ...(options.aof ? ['--appendfsync', 'always'] : []),
    '--save',
    '',
  ]);
  await waitFor(() => {
    try {
      return docker(['exec', name, 'redis-cli', 'ping']).includes('PONG');
    } catch {
      return false;
    }
  }, 30_000);
  return { ...handle(name, port), url: `redis://127.0.0.1:${port}/0` };
}
