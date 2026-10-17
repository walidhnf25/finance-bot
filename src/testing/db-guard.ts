/**
 * Safety net for tests that wipe tables: they may only ever run against a loopback database whose
 * name marks it as a test database. This makes it impossible for a misconfigured environment to
 * truncate the working database.
 */
export class UnsafeTestDatabaseError extends Error {
  constructor(reason: string) {
    super(`Refusing to run destructive tests: ${reason}`);
    this.name = 'UnsafeTestDatabaseError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '::1', '[::1]']);

export function assertSafeTestDatabase(databaseUrl: string): void {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new UnsafeTestDatabaseError('the database URL is not a valid URL');
  }
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !/^127(\.\d{1,3}){3}$/.test(host)) {
    throw new UnsafeTestDatabaseError('the database host is not a loopback address');
  }
  // `finance_bot_test`, `test`, `x_test_y` pass; `contest`, `latest_prod`, `finance_bot` do not.
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/(^|_)test($|_)/.test(name)) {
    throw new UnsafeTestDatabaseError('the database name must contain the word "test"');
  }
}

/** The test database URL: TEST_DATABASE_URL, else DATABASE_URL pointing at `<db>_test`. */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv): string {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  if (!env.DATABASE_URL)
    throw new UnsafeTestDatabaseError('neither TEST_DATABASE_URL nor DATABASE_URL is set');
  const url = new URL(env.DATABASE_URL);
  const base = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'finance_bot';
  url.pathname = `/${base.endsWith('_test') ? base : `${base}_test`}`;
  return url.toString();
}

/** Same server, the maintenance database `postgres`: used only to CREATE the test database. */
export function adminDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  url.search = '';
  return url.toString();
}
