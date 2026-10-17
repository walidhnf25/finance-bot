/**
 * Process lifecycle: an application instance must give back what it took. Starting it opens database
 * connections; closing it (the same hooks run on SIGINT/SIGTERM) must release every one of them, so
 * repeated restarts cannot leak connections until PostgreSQL refuses new ones.
 */
import { PrismaService } from '../../src/database/prisma.service';
import { buildUpdate, createTestApp } from '../setup/test-app';
import { connectTestPrisma, resetDatabase } from '../setup/test-db';

describe('application lifecycle (end to end)', () => {
  let observer: PrismaService;

  beforeAll(async () => {
    observer = await connectTestPrisma();
  });
  afterAll(async () => observer.$disconnect());

  /** Connections to the test database, not counting the observer's own. */
  const connections = async (): Promise<number> => {
    const rows = await observer.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND application_name NOT LIKE 'psql%'`;
    return Number(rows[0].n);
  };
  const settle = async (target: number): Promise<number> => {
    for (let i = 0; i < 40; i++) {
      const n = await connections();
      if (n <= target) return n;
      await new Promise((r) => setTimeout(r, 250));
    }
    return connections();
  };

  it('releases every database connection when the application closes', async () => {
    await resetDatabase(observer);
    const before = await settle(await connections());

    const t = await createTestApp({ AI_PROVIDER: 'none' });
    await t.deliver(buildUpdate(8001, 'beli kopi 25rb')).expect(200); // use the pool
    expect(await connections()).toBeGreaterThan(before);

    await t.close();
    expect(await settle(before)).toBeLessThanOrEqual(before);
  });

  it('repeated restarts do not accumulate connections and do not duplicate data', async () => {
    await resetDatabase(observer);
    const before = await settle(await connections());
    const update = buildUpdate(8002, 'beli teh 10rb', 770001);

    for (let i = 0; i < 4; i++) {
      const t = await createTestApp({ AI_PROVIDER: 'none' });
      await t.deliver(update).expect(200); // the same update again after every restart
      await t.close();
    }

    expect(await settle(before)).toBeLessThanOrEqual(before);
    expect(await observer.transaction.count()).toBe(1);
  });
});
