import { readdirSync } from 'node:fs';
import { PrismaService } from 'src/database/prisma.service';
import { JobQueue } from '../queue/domain/job-queue';
import { AiHealthProbe } from './ai-health.probe';
import { HealthService } from './health.service';
import { OcrHealthProbe } from './ocr-health.probe';

/** Every migration folder on disk counts as applied unless a test says otherwise. */
const appliedMigrations = () =>
  readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ migration_name: d.name }));

const prismaWith = (over: Partial<Record<'ping' | '$queryRaw', jest.Mock>> = {}) =>
  ({
    ping: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockImplementation(() => Promise.resolve(appliedMigrations())),
    ...over,
  }) as unknown as PrismaService;

const ai = (available: boolean) =>
  ({ check: () => Promise.resolve({ available }) }) as unknown as AiHealthProbe;
const ocr = (available: boolean) => ({ check: () => ({ available }) }) as unknown as OcrHealthProbe;
const queue = (status: 'disabled' | 'up' | 'down', enabled = true) =>
  ({ enabled, check: () => Promise.resolve({ status }) }) as unknown as JobQueue;

describe('HealthService', () => {
  it('live() never touches a dependency', () => {
    const prisma = prismaWith();
    expect(new HealthService(prisma).live().status).toBe('ok');
    expect(prisma.ping).not.toHaveBeenCalled();
  });

  it('is ok when everything is up', async () => {
    const r = await new HealthService(
      prismaWith(),
      ai(true),
      ocr(true),
      undefined,
      queue('up'),
    ).ready();
    expect(r.status).toBe('ok');
    expect(r.checks).toMatchObject({
      database: { status: 'up' },
      migrations: { status: 'up' },
      ai: { status: 'up' },
      ocr: { status: 'up' },
      queue: { status: 'up' },
    });
  });

  it('is DOWN, in a fixed sentence, when PostgreSQL does not answer', async () => {
    const prisma = prismaWith({
      ping: jest.fn().mockRejectedValue(new Error('password authentication failed for user "x"')),
    });
    const r = await new HealthService(prisma).ready();
    expect(r.status).toBe('down');
    expect(r.checks.database).toEqual({ status: 'down', detail: 'PostgreSQL is not reachable' });
    expect(r.checks.migrations.status).toBe('skipped');
    expect(JSON.stringify(r)).not.toContain('password');
  });

  it('is DOWN when a migration on disk is not applied', async () => {
    const prisma = prismaWith({ $queryRaw: jest.fn().mockResolvedValue([]) });
    const r = await new HealthService(prisma).ready();
    expect(r.status).toBe('down');
    expect(r.checks.migrations.detail).toContain('npm run prisma:deploy');
  });

  it.each([
    ['AI', () => new HealthService(prismaWith(), ai(false), ocr(true), undefined, queue('up'))],
    ['OCR', () => new HealthService(prismaWith(), ai(true), ocr(false), undefined, queue('up'))],
    ['Redis', () => new HealthService(prismaWith(), ai(true), ocr(true), undefined, queue('down'))],
  ])(
    'an optional capability (%s) that is down makes the app degraded, never down',
    async (_n, make) => {
      const r = await make().ready();
      expect(r.status).toBe('degraded');
    },
  );

  it('reports the queue as skipped when it is switched off', async () => {
    const r = await new HealthService(
      prismaWith(),
      ai(true),
      ocr(true),
      undefined,
      queue('disabled', false),
    ).ready();
    expect(r.checks.queue.status).toBe('skipped');
    expect(r.status).toBe('ok');
  });

  it('caches readiness for a few seconds so a probe loop cannot hammer the database', async () => {
    const prisma = prismaWith();
    const service = new HealthService(prisma);
    await service.ready();
    await service.ready();
    expect(prisma.ping).toHaveBeenCalledTimes(1);
  });
});
