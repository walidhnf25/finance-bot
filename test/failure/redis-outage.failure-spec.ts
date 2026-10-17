/**
 * Redis (the optional queue backend) really goes away and comes back. Throw-away container, never the
 * compose Redis.
 *
 *   1. Under a running bot: while Redis is down a receipt photo is still read (in-process fallback) and the
 *      app stays ready-but-degraded; when Redis returns, photos are queued again.
 *   2. Durability: jobs written while nobody was working survive a hard kill of Redis (AOF), then get done.
 */
import sharp from 'sharp';
import request from 'supertest';
import type { Server } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from 'src/modules/queue/domain/job-queue';
import { BullJobQueue } from 'src/modules/queue/infrastructure/bull-job-queue';
import { ReceiptOcr } from 'src/modules/receipt/infrastructure/ocr';
import { buildUpdate, createTestApp, TestApp } from '../setup/test-app';
import { resetDatabase } from '../setup/test-db';
import { Disposable, sleep, startDisposableRedis, waitFor } from './docker';

class StubOcr extends ReceiptOcr {
  read(): Promise<string> {
    return Promise.resolve('WARUNG MAKAN\nNasi 10.000\nTeh 5.000\nTOTAL 15.000\nTUNAI 20.000');
  }
}
const USER = 7401;
let shade = 0;
const png = (): Promise<Buffer> =>
  sharp({
    create: {
      width: 70 + ++shade,
      height: 50,
      channels: 3,
      background: { r: shade, g: 40, b: 40 },
    },
  })
    .png()
    .toBuffer();

describe('Redis outage under a running bot', () => {
  let redis: Awaited<ReturnType<typeof startDisposableRedis>>;
  let t: TestApp;

  beforeAll(async () => {
    redis = await startDisposableRedis();
    t = await createTestApp(
      {
        REDIS_URL: redis.url,
        REDIS_KEY_PREFIX: 'fi:',
        RECEIPT_AI_MODE: 'never',
        REDIS_CONNECT_TIMEOUT_MS: '500',
      },
      (b) => b.overrideProvider(ReceiptOcr).useValue(new StubOcr()),
    );
    await resetDatabase(t.prisma);
  });
  afterAll(async () => {
    await t?.close();
    (redis as Disposable | undefined)?.remove();
  });

  const photo = async (id: string) => {
    const bytes = await png();
    t.telegram.files.set(id, bytes);
    return buildUpdate(USER, '', undefined, {
      text: undefined,
      date: Math.floor(Date.now() / 1000),
      photo: [{ file_id: id, file_unique_id: id, width: 70, height: 50, file_size: bytes.length }],
    });
  };
  const texts = () => t.telegram.texts.map((m) => m.text);

  it('still reads receipts while Redis is down, reports degraded, and queues again once it is back', async () => {
    await t.say(USER, 'halo').expect(200);

    t.telegram.clear();
    await t.deliver(await photo('FI-PHOTO-QUEUED-1')).expect(200);
    expect(texts()[0]).toContain('Struk diterima'); // queued while Redis is healthy
    await waitFor(() => texts().some((m) => m.includes('Rp15.000')), 20_000);
    await t.say(USER, 'batal').expect(200); // clear the pending draft

    redis.kill();
    t.telegram.clear();
    await t.deliver(await photo('FI-PHOTO-DOWN-0002')).expect(200);
    expect(texts().some((m) => m.includes('Rp15.000'))).toBe(true); // read in-process, right away
    expect(texts().some((m) => m.includes('Struk diterima'))).toBe(false);
    await t.say(USER, 'batal').expect(200);

    const res = await request(t.app.getHttpServer() as Server)
      .get('/health/ready')
      .set('Host', '127.0.0.1');
    const body = res.body as { status: string; checks: { queue: { status: string } } };
    expect(res.status).toBe(200); // degraded, not down: the bot still works
    expect(body.checks.queue.status).toBe('degraded');

    redis.start();
    await waitFor(async () => {
      const r = await request(t.app.getHttpServer() as Server)
        .get('/health/ready')
        .set('Host', '127.0.0.1');
      return (r.body as { checks: { queue: { status: string } } }).checks.queue.status === 'up';
    }, 30_000);

    t.telegram.clear();
    await t.deliver(await photo('FI-PHOTO-BACK-0003')).expect(200);
    expect(texts()[0]).toContain('Struk diterima'); // queued again
    await waitFor(() => texts().some((m) => m.includes('Rp15.000')), 20_000);
  });
});

describe('queued jobs survive a hard kill of Redis', () => {
  let redis: Awaited<ReturnType<typeof startDisposableRedis>>;
  beforeAll(async () => {
    redis = await startDisposableRedis({ aof: true }); // the same persistence the compose service uses
  });
  afterAll(() => (redis as Disposable | undefined)?.remove());

  const settings = (): ConfigService =>
    ({
      getOrThrow: () => ({
        redisUrl: redis.url,
        connectTimeoutMs: 1_000,
        keyPrefix: 'dur:',
        shutdownGraceMs: 1_000,
      }),
    }) as unknown as ConfigService;

  it('keeps waiting jobs across kill -9 and runs them afterwards (AOF)', async () => {
    const producer = new BullJobQueue(settings());
    for (let i = 0; i < 3; i += 1) {
      await producer.enqueue(QUEUE_NAMES.receipts, 'read', { n: i }, { jobId: `dur-${i}` });
    }
    // no waiting for a flush: with appendfsync always an acknowledged enqueue is already on disk
    await producer.onModuleDestroy();
    redis.kill();
    redis.start();
    await sleep(1_500);

    const worker = new BullJobQueue(settings());
    const seen: number[] = [];
    worker.registerHandler(QUEUE_NAMES.receipts, 'read', (data) => {
      seen.push((data as { n: number }).n);
      return Promise.resolve();
    });
    worker.onApplicationBootstrap();
    await waitFor(() => seen.length === 3, 30_000);
    expect(seen.sort()).toEqual([0, 1, 2]);
    await worker.onModuleDestroy();
  });
});
