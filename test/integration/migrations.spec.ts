/**
 * Migrations on a real, empty PostgreSQL database. Applies every migration in `prisma/migrations` exactly as
 * `prisma migrate deploy` does in production, then checks that the result matches `schema.prisma` and that the
 * rules which Prisma cannot express (CHECK constraints, triggers) are really there and enforced.
 *
 * The throw-away database is named `<test database>_migr`, and the destructive-test guard is applied to it.
 */
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  adminDatabaseUrl,
  assertSafeTestDatabase,
  resolveTestDatabaseUrl,
} from '../../src/testing/db-guard';

const ROOT = resolve(__dirname, '..', '..');
const PRISMA_CLI = join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const SCHEMA = join(ROOT, 'prisma', 'schema.prisma');

describe('migrations (PostgreSQL)', () => {
  const testUrl = resolveTestDatabaseUrl(process.env);
  const baseName = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  const dbName = `${baseName}_migr`;
  const migrUrl = (() => {
    const u = new URL(testUrl);
    u.pathname = `/${dbName}`;
    return u.toString();
  })();
  const migrations = readdirSync(join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  let admin: PrismaClient;
  let db: PrismaClient;

  const prisma = (args: string[]): string =>
    execFileSync(process.execPath, [PRISMA_CLI, ...args], {
      env: { ...process.env, DATABASE_URL: migrUrl },
      stdio: 'pipe',
    }).toString();

  beforeAll(async () => {
    assertSafeTestDatabase(migrUrl);
    expect(existsSync(PRISMA_CLI)).toBe(true);
    admin = new PrismaClient({ datasourceUrl: adminDatabaseUrl(testUrl) });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    prisma(['migrate', 'deploy', '--schema', SCHEMA]);
    db = new PrismaClient({ datasourceUrl: migrUrl });
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.$disconnect();
  });

  it('records every migration as finished', async () => {
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    const rows = await db.$queryRawUnsafe<Array<{ migration_name: string; finished: boolean }>>(
      `SELECT migration_name, (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished
       FROM _prisma_migrations ORDER BY migration_name`,
    );
    expect(rows.map((r) => r.migration_name)).toEqual(migrations);
    expect(rows.every((r) => r.finished)).toBe(true);
  });

  it('produces exactly the schema that schema.prisma describes', () => {
    // exits non-zero (and throws) when the database and the datamodel differ
    expect(() =>
      prisma([
        'migrate',
        'diff',
        '--from-url',
        migrUrl,
        '--to-schema-datamodel',
        SCHEMA,
        '--exit-code',
      ]),
    ).not.toThrow();
  });

  it('enforces the money rules in the database itself', async () => {
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, telegram_id, display_name, updated_at) VALUES ('u1','111','Ani', now())`,
    );
    const insert = (amount: number) =>
      db.$executeRawUnsafe(
        `INSERT INTO transactions (id, user_id, type, amount_minor, description, occurred_at, updated_at)
         VALUES ('t${amount}','u1','EXPENSE', ${amount}, 'x', now(), now())`,
      );
    await expect(insert(2500000)).resolves.toBeDefined();
    await expect(insert(0)).rejects.toThrow();
    await expect(insert(-5)).rejects.toThrow();
  });

  it('has an audit table whose rules are enforced by the database', async () => {
    // accepts a normal event for any user id (no foreign key)
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO audit_events (id, user_id, action, metadata) VALUES ('e1','gone-user','USER_RESET','{"k":1}')`,
      ),
    ).resolves.toBeDefined();
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO audit_events (id, action) VALUES ('e2', '${'A'.repeat(65)}')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(`INSERT INTO audit_events (id, action) VALUES ('e3', '')`),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO audit_events (id, action, metadata) VALUES ('e4','X', jsonb_build_object('b', repeat('x', 6000)))`,
      ),
    ).rejects.toThrow();
  });

  it('installs the tenant-guard triggers, and they guard every write', async () => {
    const triggers = await db.$queryRawUnsafe<Array<{ tgname: string }>>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
    );
    expect(triggers.map((t) => t.tgname)).toEqual([
      'budgets_category_owner',
      'categories_owner_unchanged',
      'receipt_drafts_transaction_owner',
      'transactions_category_owner',
    ]);

    await db.$executeRawUnsafe(
      `INSERT INTO users (id, telegram_id, display_name, updated_at) VALUES ('g1','333','Ani', now()), ('g2','444','Budi', now())`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO categories (id, user_id, name, type, keywords, created_at)
       VALUES ('gc1','g1','Ani makan','EXPENSE','{}', now()), ('gc2','g2','Budi makan','EXPENSE','{}', now()), ('gsys',NULL,'Sistem','EXPENSE','{}', now())`,
    );
    const insertTx = (id: string, user: string, category: string | null) =>
      db.$executeRawUnsafe(
        `INSERT INTO transactions (id, user_id, type, amount_minor, category_id, description, occurred_at, updated_at)
         VALUES ('${id}','${user}','EXPENSE', 1000, ${category ? `'${category}'` : 'NULL'}, 'x', now(), now())`,
      );
    await expect(insertTx('gok1', 'g1', 'gc1')).resolves.toBeDefined(); // own category
    await expect(insertTx('gok2', 'g1', 'gsys')).resolves.toBeDefined(); // shared system category
    await expect(insertTx('gok3', 'g1', null)).resolves.toBeDefined(); // no category
    await expect(insertTx('gbad', 'g1', 'gc2')).rejects.toThrow(/category does not belong/);
    await expect(
      db.$executeRawUnsafe(`UPDATE transactions SET category_id = 'gc2' WHERE id = 'gok1'`),
    ).rejects.toThrow(/category does not belong/);
    // a category still in use cannot change owner
    await expect(
      db.$executeRawUnsafe(`UPDATE categories SET user_id = 'g2' WHERE id = 'gc1'`),
    ).rejects.toThrow(/still used/);
  });
});
