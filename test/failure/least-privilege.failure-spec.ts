/**
 * The bot running as a NON-superuser database role (docs/operations/db-least-privilege.md), against a
 * throw-away PostgreSQL. Three things are proven:
 *
 *   1. the bot works with only the privileges it needs (read/write rows, no DDL, no superuser);
 *   2. what the role CANNOT do: change the schema, switch the tenant triggers off, replace their functions,
 *      bypass them with `session_replication_role`, or rewrite the migration history;
 *   3. a role that is allowed to create TEMP tables cannot shadow `categories`/`transactions` to fool a trigger.
 *
 * Every negative check also demands the right KIND of refusal (permission denied / must be owner) and the
 * suite begins with a positive control, so a broken connection cannot make a "cannot" assertion pass.
 *
 * Applying this to the real database is an operational change: OWNER APPROVAL REQUIRED.
 */
import { execSync } from 'node:child_process';
import request from 'supertest';
import type { Server } from 'node:http';
import { createTestApp, TestApp } from '../setup/test-app';
import { Disposable, DisposablePostgres, startDisposablePostgres } from './docker';

const APP_ROLE = 'finance_bot_app';
const APP_PASSWORD = 'least-priv-test-only';
const USER = 8601;

/** The exact statements documented for the owner (kept in sync with docs/operations/db-least-privilege.md). */
const GRANTS = (db: string, owner: string) => `
CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE "${db}" TO ${APP_ROLE};
GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
REVOKE INSERT, UPDATE, DELETE ON "_prisma_migrations" FROM ${APP_ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE};
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE "${db}" FROM PUBLIC;
`;

const REFUSED = /permission denied|must be owner|must be superuser|insufficient privilege/i;

describe('the bot as a least-privilege database role', () => {
  let pg: DisposablePostgres;
  let t: TestApp;
  const asApp = (sql: string): { ok: boolean; out: string } => {
    try {
      const out = execSync(
        `docker exec -e PGPASSWORD=${APP_PASSWORD} ${pg.name} psql -h 127.0.0.1 -U ${APP_ROLE} -d ${pg.db} -v ON_ERROR_STOP=1 -tAc "${sql.replace(/"/g, '\\"')}"`,
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, MSYS_NO_PATHCONV: '1' },
        },
      );
      return { ok: true, out };
    } catch (err) {
      return { ok: false, out: String((err as { stderr?: string }).stderr ?? err) };
    }
  };
  /** The statement must be REFUSED, and for a privilege reason (not a typo or a dead connection). */
  const denied = (sql: string) => {
    const r = asApp(sql);
    expect({ sql, ok: r.ok }).toEqual({ sql, ok: false });
    expect({ sql, refusedForPrivilege: REFUSED.test(r.out) }).toEqual({
      sql,
      refusedForPrivilege: true,
    });
  };

  beforeAll(async () => {
    pg = await startDisposablePostgres({ user: 'finance_bot', db: 'finance_bot_test' });
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: pg.url },
      stdio: 'ignore',
    });
    for (const stmt of GRANTS(pg.db, pg.user)
      .split(';\n')
      .filter((s) => s.trim())) {
      pg.run(stmt);
    }
    const appUrl = `postgresql://${APP_ROLE}:${APP_PASSWORD}@127.0.0.1:${pg.port}/${pg.db}?schema=public`;
    t = await createTestApp({ DATABASE_URL: appUrl });
  });
  afterAll(async () => {
    await t?.close();
    (pg as Disposable | undefined)?.remove();
  });

  it('POSITIVE CONTROL: the role can connect and read and write rows', () => {
    expect(asApp('SELECT 1').ok).toBe(true);
    expect(asApp('SELECT count(*) FROM transactions').ok).toBe(true);
    expect(asApp('SELECT count(*) FROM _prisma_migrations').ok).toBe(true);
  });

  it('is not a superuser and cannot create databases, roles or objects', () => {
    expect(
      pg
        .run(
          `SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '${APP_ROLE}'`,
        )
        .trim(),
    ).toBe('f|f|f');
    denied('CREATE TABLE evil (x int)');
    denied('CREATE ROLE evil LOGIN');
    denied('CREATE DATABASE evil');
  });

  it('the bot works end to end with only row privileges (record, edit, delete, reset, readiness)', async () => {
    await t.say(USER, 'halo').expect(200);
    await t.say(USER, '1').expect(200); // cash only
    await t.say(USER, '50rb').expect(200);
    t.telegram.clear();
    await t.say(USER, 'beli kopi 25rb').expect(200);
    expect(t.telegram.last()).toContain('Berhasil dicatat');
    await t.say(USER, 'ubah jadi 30rb').expect(200);
    expect(await t.prisma.transaction.count({ where: { description: { contains: 'kopi' } } })).toBe(
      1,
    );
    await t.say(USER, 'reset').expect(200);
    await t.say(USER, 'ya').expect(200);
    expect(await t.prisma.transaction.count()).toBe(0);
    const ready = await request(t.app.getHttpServer() as Server)
      .get('/health/ready')
      .set('Host', '127.0.0.1');
    expect(ready.status).toBe(200); // reads _prisma_migrations without being able to write it
  });

  it('cannot alter the schema, drop or replace the tenant guards, switch them off, or bypass them', () => {
    denied('ALTER TABLE transactions ADD COLUMN evil int');
    denied('DROP TABLE transactions');
    denied('DROP TRIGGER transactions_category_owner ON transactions');
    denied('ALTER TABLE transactions DISABLE TRIGGER transactions_category_owner');
    denied('ALTER TABLE transactions DISABLE TRIGGER ALL');
    denied('SET session_replication_role = replica');
    denied('TRUNCATE transactions');
    denied(
      'CREATE OR REPLACE FUNCTION finance_bot_assert_category_owner() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql',
    );
    // the migration history cannot be rewritten to hide a change
    denied("DELETE FROM _prisma_migrations WHERE migration_name LIKE '%tenant%'");
    // and the guards are all still in place afterwards
    expect(
      pg
        .run(
          "SELECT count(*) FROM pg_trigger WHERE tgname IN ('transactions_category_owner','budgets_category_owner','receipt_drafts_transaction_owner','categories_owner_unchanged')",
        )
        .trim(),
    ).toBe('4');
  });

  it('cannot fool a trigger with a TEMP table that shadows `categories` (no TEMP privilege; names are schema-qualified)', () => {
    // two real users, each with a private category
    pg.run(
      "INSERT INTO users (id, telegram_id, display_name, updated_at) VALUES ('u-a','7001','A', now()), ('u-b','7002','B', now())",
    );
    pg.run(
      "INSERT INTO categories (id, user_id, name, type, keywords, created_at) VALUES ('c-a','u-a','A makan','EXPENSE','{}', now()), ('c-b','u-b','B makan','EXPENSE','{}', now())",
    );
    // 1. the role is not even allowed to create temp tables
    denied('CREATE TEMP TABLE categories (id text, user_id text)');
    // 2. and even a role that WERE allowed (simulated by the owner granting TEMP) cannot shadow the table,
    //    because the trigger reads public.categories explicitly
    pg.run('GRANT TEMPORARY ON DATABASE "finance_bot_test" TO finance_bot_app');
    try {
      const attack = asApp(
        "CREATE TEMP TABLE categories (id text, user_id text); INSERT INTO categories VALUES ('c-b', NULL); INSERT INTO transactions (id, user_id, type, amount_minor, category_id, description, occurred_at, created_at, updated_at) VALUES (gen_random_uuid(), 'u-a', 'EXPENSE', 100, 'c-b', 'cross-tenant', now(), now(), now())",
      );
      expect(attack.ok).toBe(false);
      expect(attack.out).toContain('category does not belong');
    } finally {
      pg.run('REVOKE TEMPORARY ON DATABASE "finance_bot_test" FROM finance_bot_app');
    }
    expect(
      pg.run("SELECT count(*) FROM transactions WHERE description = 'cross-tenant'").trim(),
    ).toBe('0');
  });
});
