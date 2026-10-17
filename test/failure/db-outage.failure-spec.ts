/**
 * PostgreSQL really goes away and comes back, under a running bot. The database is a throw-away Docker
 * container (never your data), stopped and started for real while the NestJS app, the HTTP webhook and the
 * connection pool stay up.
 *
 * What a person relies on: while the database is down the bot says "not now" in a way that makes Telegram
 * send the message again (HTTP 503), it never crashes or invents a success, /health/live stays green,
 * /health/ready turns red, and once the database is back the very same message is recorded exactly once.
 *
 *   npm run test:failure        (needs Docker; pulls postgres:16-alpine once)
 */
import { execSync } from 'node:child_process';
import request from 'supertest';
import type { Server } from 'node:http';
import { buildUpdate, createTestApp, TestApp } from '../setup/test-app';
import { Disposable, startDisposablePostgres, waitFor } from './docker';

const USER = 7301;

describe('PostgreSQL outage under a running bot', () => {
  let pg: Awaited<ReturnType<typeof startDisposablePostgres>>;
  let t: TestApp;

  beforeAll(async () => {
    pg = await startDisposablePostgres();
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: pg.url },
      stdio: 'ignore',
    });
    t = await createTestApp({ DATABASE_URL: pg.url });
  });
  afterAll(async () => {
    await t?.close();
    (pg as Disposable | undefined)?.remove();
  });

  const http = () => request(t.app.getHttpServer() as Server);
  const recorded = () => t.prisma.transaction.count();
  const ready = async () => {
    const res = await http().get('/health/ready').set('Host', '127.0.0.1');
    return {
      status: res.status,
      body: res.body as {
        status: string;
        checks: Record<string, { status: string; detail?: string }>;
      },
    };
  };

  it('refuses with 503 while down, keeps living, and records the redelivered message exactly once', async () => {
    await t.say(USER, 'halo').expect(200);
    expect(await recorded()).toBe(0);

    pg.stop(); // the database goes away under the running app
    const update = buildUpdate(USER, 'beli kopi 25rb');

    await t.deliver(update).expect(503); // Telegram will redeliver this
    await http().get('/health/live').set('Host', '127.0.0.1').expect(200); // alive: no restart loop
    // readiness is cached for a few seconds; poll until it notices
    await waitFor(async () => (await ready()).status === 503, 15_000);
    const down = await ready();
    expect(down.body.checks.database).toMatchObject({
      status: 'down',
      detail: 'PostgreSQL is not reachable',
    });
    expect(JSON.stringify(down.body)).not.toContain(pg.password); // no connection string, ever

    pg.start(); // the database comes back
    await waitFor(() => {
      try {
        pg.run('SELECT 1');
        return true;
      } catch {
        return false;
      }
    }, 60_000);

    // the same update is redelivered (Telegram does this on a 503): it must now succeed, once
    await waitFor(async () => (await t.deliver(update)).status === 200, 60_000);
    await t.deliver(update).expect(200); // and a further redelivery changes nothing
    expect(await recorded()).toBe(1);
    await waitFor(async () => (await ready()).status === 200, 30_000);
  });

  it('survives a hard kill of the database in the middle of traffic', async () => {
    const before = await recorded();
    pg.kill(); // no graceful shutdown at all
    for (let i = 0; i < 5; i += 1) await t.say(USER, `beli kopi ${100 + i}rb`).expect(503);
    pg.start();
    await waitFor(() => {
      try {
        pg.run('SELECT 1');
        return true;
      } catch {
        return false;
      }
    }, 60_000);
    await waitFor(async () => (await t.say(USER, 'beli kopi 7rb')).status === 200, 60_000);
    expect(await recorded()).toBe(before + 1); // the refused messages left nothing behind
  });
});
