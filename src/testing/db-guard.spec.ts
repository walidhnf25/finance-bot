import {
  adminDatabaseUrl,
  assertSafeTestDatabase,
  resolveTestDatabaseUrl,
  UnsafeTestDatabaseError,
} from './db-guard';

describe('assertSafeTestDatabase (protects the working database from destructive tests)', () => {
  it.each([
    'postgresql://u:p@127.0.0.1:55432/finance_bot_test',
    'postgresql://u:p@localhost:5432/test',
    'postgresql://u:p@[::1]:5432/app_test_run',
    'postgresql://u:p@127.5.5.5/x_test',
  ])('accepts %s', (url) => {
    expect(() => assertSafeTestDatabase(url)).not.toThrow();
  });

  it.each([
    ['the working database', 'postgresql://u:p@127.0.0.1:55432/finance_bot'],
    ['a lookalike name', 'postgresql://u:p@127.0.0.1/contest'],
    ['a name that merely ends in test letters', 'postgresql://u:p@127.0.0.1/latest'],
    ['a prod-ish name', 'postgresql://u:p@127.0.0.1/latest_prod'],
    ['a remote host', 'postgresql://u:p@db.example.com/finance_bot_test'],
    ['a private network host', 'postgresql://u:p@192.168.1.5/finance_bot_test'],
    ['garbage', 'not a url'],
    ['an empty database name', 'postgresql://u:p@127.0.0.1/'],
  ])('refuses %s', (_name, url) => {
    expect(() => assertSafeTestDatabase(url)).toThrow(UnsafeTestDatabaseError);
  });

  it('never repeats the connection string (it holds a password) in its error', () => {
    let message = '';
    try {
      assertSafeTestDatabase('postgresql://admin:SuperSecret@db.example.com/prod');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('SuperSecret');
    expect(message).not.toContain('db.example.com');
  });
});

describe('resolveTestDatabaseUrl', () => {
  it('prefers TEST_DATABASE_URL', () => {
    expect(
      resolveTestDatabaseUrl({
        TEST_DATABASE_URL: 'postgresql://a/b_test',
        DATABASE_URL: 'postgresql://c/d',
      }),
    ).toBe('postgresql://a/b_test');
  });

  it('derives <db>_test from DATABASE_URL, never reusing the working database', () => {
    const url = resolveTestDatabaseUrl({
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:55432/finance_bot?schema=public',
    });
    expect(new URL(url).pathname).toBe('/finance_bot_test');
    expect(new URL(url).search).toBe('?schema=public');
    expect(
      resolveTestDatabaseUrl({ DATABASE_URL: 'postgresql://u:p@127.0.0.1/finance_bot_test' }),
    ).toContain('/finance_bot_test');
  });

  it('fails when nothing is configured', () => {
    expect(() => resolveTestDatabaseUrl({})).toThrow(UnsafeTestDatabaseError);
  });

  it('points the admin connection at the maintenance database', () => {
    expect(adminDatabaseUrl('postgresql://u:p@127.0.0.1:5/finance_bot_test?schema=public')).toBe(
      'postgresql://u:p@127.0.0.1:5/postgres',
    );
  });
});
