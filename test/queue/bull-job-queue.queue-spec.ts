/* eslint-disable @typescript-eslint/require-await -- JobHandler must return a Promise; most test handlers have nothing to await */
/**
 * The BullMQ-backed JobQueue against a REAL Redis (the optional `queue` compose profile, database 15, a
 * private key prefix per test). Nothing is mocked: retries, dead-letter behaviour, dedupe, restarts and an
 * unreachable Redis are exercised for real.
 *
 *   npm run test:queue        (starts the Redis container if needed)
 */
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  JobContext,
  QUEUE_NAMES,
  QueueUnavailableError,
  RejectedJobError,
} from 'src/modules/queue/domain/job-queue';
import { BullJobQueue } from 'src/modules/queue/infrastructure/bull-job-queue';
import { MetricsService } from 'src/modules/observability/metrics.service';

import { TEST_REDIS_URL } from './redis';

const settings = (prefix: string, redisUrl = TEST_REDIS_URL) =>
  ({
    getOrThrow: () => ({
      redisUrl,
      connectTimeoutMs: 1_000,
      keyPrefix: prefix,
      shutdownGraceMs: 1_000,
    }),
  }) as unknown as ConfigService;

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not reached in time');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BullJobQueue (real Redis)', () => {
  let prefix: string;
  let raw: Redis;
  const open: BullJobQueue[] = [];

  const make = (metrics?: MetricsService, url?: string): BullJobQueue => {
    const q = new BullJobQueue(settings(prefix, url), metrics);
    open.push(q);
    return q;
  };
  /** Registers handlers, then lets the worker start (what Nest does after bootstrap). */
  const start = (q: BullJobQueue): void => q.onApplicationBootstrap();

  beforeAll(() => {
    raw = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
  });
  afterAll(async () => {
    await raw.quit();
  });
  beforeEach(() => {
    prefix = `t${randomUUID().slice(0, 8)}:`;
  });
  afterEach(async () => {
    await Promise.allSettled(open.splice(0).map((q) => q.onModuleDestroy()));
    const keys = await raw.keys(`${prefix}*`);
    if (keys.length) await raw.del(...keys);
  });

  it('is inert when no REDIS_URL is configured', async () => {
    const q = make(undefined, '');
    expect(q.enabled).toBe(false);
    await expect(q.enqueue(QUEUE_NAMES.receipts, 'x', {})).rejects.toBeInstanceOf(
      QueueUnavailableError,
    );
    expect(await q.check()).toEqual({ status: 'disabled' });
    await expect(q.scheduleEvery(QUEUE_NAMES.maintenance, 'x', 1_000)).resolves.toBeUndefined();
  });

  it('runs an enqueued job through its handler, once', async () => {
    const q = make();
    const seen: Array<{ data: unknown; ctx: JobContext }> = [];
    q.registerHandler(QUEUE_NAMES.receipts, 'read', async (data, ctx) => {
      seen.push({ data, ctx });
    });
    start(q);
    expect(await q.enqueue(QUEUE_NAMES.receipts, 'read', { n: 1 }, { jobId: 'a1' })).toBe(
      'enqueued',
    );
    await until(() => seen.length === 1);
    await sleep(300);
    expect(seen).toHaveLength(1);
    expect((seen[0].data as { n: number }).n).toBe(1);
    expect(seen[0].ctx).toMatchObject({ attempt: 1, maxAttempts: 1 });
    expect(typeof seen[0].ctx.correlationId).toBe('string');
  });

  it('ignores a second enqueue with the same job id (idempotent hand-over)', async () => {
    const q = make();
    let runs = 0;
    q.registerHandler(QUEUE_NAMES.receipts, 'read', async () => {
      runs += 1;
    });
    start(q);
    expect(await q.enqueue(QUEUE_NAMES.receipts, 'read', {}, { jobId: 'same' })).toBe('enqueued');
    expect(await q.enqueue(QUEUE_NAMES.receipts, 'read', {}, { jobId: 'same' })).toBe('duplicate');
    // 20 parallel callers with one id still produce a single run
    await Promise.all(
      Array.from({ length: 20 }, () =>
        q.enqueue(QUEUE_NAMES.receipts, 'read', {}, { jobId: 'same' }),
      ),
    );
    await until(() => runs >= 1);
    await sleep(500);
    expect(runs).toBe(1);
  });

  it('retries a failing job with backoff and succeeds on a later attempt (and counts each outcome)', async () => {
    const metrics = new MetricsService();
    const q = make(metrics);
    const attempts: number[] = [];
    q.registerHandler(QUEUE_NAMES.receipts, 'read', async (_d, ctx) => {
      attempts.push(ctx.attempt);
      if (ctx.attempt < 3) throw new Error('transient');
    });
    start(q);
    await q.enqueue(QUEUE_NAMES.receipts, 'read', {}, { jobId: 'r1', attempts: 3, backoffMs: 100 });
    await until(() => attempts.length === 3);
    expect(attempts).toEqual([1, 2, 3]);
    await until(() => metrics.render().includes('outcome="completed"'));
    const text = metrics.render();
    expect(text).toContain('queue_jobs_total{queue="receipts",outcome="retried"} 2');
    expect(text).toContain('queue_jobs_total{queue="receipts",outcome="completed"} 1');
    expect(text).not.toContain('outcome="failed"');
    metrics.close();
  });

  it('calls the final-failure handler once, only after the retries are used up', async () => {
    const metrics = new MetricsService();
    const q = make(metrics);
    const gaveUp: unknown[] = [];
    let tries = 0;
    q.registerHandler(QUEUE_NAMES.receipts, 'read', async () => {
      tries += 1;
      throw new Error('always');
    });
    q.onFinalFailure(QUEUE_NAMES.receipts, 'read', async (data) => {
      gaveUp.push(data);
    });
    start(q);
    await q.enqueue(
      QUEUE_NAMES.receipts,
      'read',
      { who: 'x' },
      { jobId: 'f1', attempts: 3, backoffMs: 50 },
    );
    await until(() => gaveUp.length === 1);
    await sleep(300);
    expect(tries).toBe(3);
    expect(gaveUp).toHaveLength(1);
    expect(await q.counts(QUEUE_NAMES.receipts)).toMatchObject({ failed: 1, active: 0 });
    const text = metrics.render();
    expect(text).toContain('queue_jobs_total{queue="receipts",outcome="retried"} 2');
    expect(text).toContain('queue_jobs_total{queue="receipts",outcome="failed"} 1');
    metrics.close();
  });

  it('never retries a rejected payload, scrubs it, and still reports the final failure', async () => {
    const q = make();
    let tries = 0;
    const finals: string[] = [];
    q.registerHandler(QUEUE_NAMES.receipts, 'read', async () => {
      tries += 1;
      throw new RejectedJobError('unexpected_field');
    });
    q.onFinalFailure(QUEUE_NAMES.receipts, 'read', async (_d, reason) => {
      finals.push(reason);
    });
    start(q);
    await q.enqueue(
      QUEUE_NAMES.receipts,
      'read',
      { payload: 'x'.repeat(100_000) },
      { jobId: 'bad1', attempts: 5, backoffMs: 50 },
    );
    await until(() => finals.length === 1);
    await sleep(300);
    expect(tries).toBe(1); // attempts: 5, yet no retry
    // the oversized/hostile payload was replaced, so it does not sit in the failed set for a week
    const stored = await raw.hget(`${prefix}bull:${QUEUE_NAMES.receipts}:bad1`, 'data');
    expect(stored).not.toContain('xxxxx');
    expect(stored).toContain('unexpected_field');
  });

  it('fails a job that outlives its timeout', async () => {
    const q = make();
    const finals: string[] = [];
    q.registerHandler(QUEUE_NAMES.receipts, 'read', () => new Promise(() => undefined), {
      timeoutMs: 200,
    });
    q.onFinalFailure(QUEUE_NAMES.receipts, 'read', async (_d, reason) => {
      finals.push(reason);
    });
    start(q);
    await q.enqueue(QUEUE_NAMES.receipts, 'read', {}, { jobId: 't1' });
    await until(() => finals.length === 1);
    expect(await q.counts(QUEUE_NAMES.receipts)).toMatchObject({ failed: 1 });
  });

  it('a job enqueued while no worker runs is still there for the next process (restart recovery)', async () => {
    const producer = make();
    await producer.enqueue(QUEUE_NAMES.receipts, 'read', { n: 7 }, { jobId: 'persist1' });
    await producer.onModuleDestroy(); // the "first process" goes away

    const second = make();
    const seen: unknown[] = [];
    second.registerHandler(QUEUE_NAMES.receipts, 'read', async (data) => {
      seen.push(data);
    });
    start(second);
    await until(() => seen.length === 1);
    expect((seen[0] as { n: number }).n).toBe(7);
  });

  it('shutdown waits for the job in hand instead of cutting it off', async () => {
    const q = make();
    let started = false;
    let finished = false;
    q.registerHandler(QUEUE_NAMES.receipts, 'read', async () => {
      started = true;
      await sleep(800);
      finished = true;
    });
    start(q);
    await q.enqueue(QUEUE_NAMES.receipts, 'read', {}, { jobId: 'g1' });
    await until(() => started);
    await q.onModuleDestroy();
    expect(finished).toBe(true);
  });

  it('respects the concurrency setting', async () => {
    const q = make();
    let active = 0;
    let peak = 0;
    let done = 0;
    q.registerHandler(
      QUEUE_NAMES.receipts,
      'read',
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(150);
        active -= 1;
        done += 1;
      },
      { concurrency: 2 },
    );
    start(q);
    for (let i = 0; i < 6; i += 1) {
      await q.enqueue(QUEUE_NAMES.receipts, 'read', {}, { jobId: `c${i}` });
    }
    await until(() => done === 6);
    expect(peak).toBe(2);
  });

  it('fails fast with QueueUnavailableError when Redis cannot be reached', async () => {
    const q = make(undefined, 'redis://127.0.0.1:1/0');
    const started = Date.now();
    await expect(
      q.enqueue(QUEUE_NAMES.receipts, 'read', {}, { jobId: 'x' }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await q.check()).toEqual({ status: 'down', detail: 'Redis is not reachable' });
  });

  it('shuts down in bounded time even when Redis is gone (it must never hang the process exit)', async () => {
    const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const q = make(undefined, 'redis://127.0.0.1:1/0');
    q.registerHandler(QUEUE_NAMES.receipts, 'read', async () => undefined);
    start(q); // the worker starts and cannot connect
    await q.enqueue(QUEUE_NAMES.receipts, 'read', {}).catch(() => undefined); // creates the producer too
    const started = Date.now();
    await q.onModuleDestroy();
    expect(Date.now() - started).toBeLessThan(10_000);
    // and nothing may keep retrying afterwards: a leftover reconnect timer would stop the process from exiting
    await sleep(3_500);
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    expect(timers()).toBeLessThanOrEqual(timersBefore);
  });

  it('reports a reachable Redis as up', async () => {
    expect(await make().check()).toEqual({ status: 'up' });
  });

  it('keeps ONE repeating schedule, and replaces it when the interval changes', async () => {
    const q = make();
    let runs = 0;
    q.registerHandler(QUEUE_NAMES.maintenance, 'retention', async () => {
      runs += 1;
    });
    start(q);
    await q.scheduleEvery(QUEUE_NAMES.maintenance, 'retention', 200);
    await q.scheduleEvery(QUEUE_NAMES.maintenance, 'retention', 200); // another process asking
    await until(() => runs >= 2);
    await q.scheduleEvery(QUEUE_NAMES.maintenance, 'retention', 60_000);
    const schedulers = await raw.zcard(`${prefix}bull:${QUEUE_NAMES.maintenance}:repeat`);
    expect(schedulers).toBe(1);
    const before = runs;
    await sleep(600);
    expect(runs - before).toBeLessThanOrEqual(1); // the 200 ms schedule is gone
  });

  it('counts outcomes in the metrics without ever exposing a payload', async () => {
    const metrics = new MetricsService();
    const q = make(metrics);
    q.registerHandler(QUEUE_NAMES.receipts, 'read', async () => undefined);
    start(q);
    await q.enqueue(QUEUE_NAMES.receipts, 'read', { secret: 'amount 99999' }, { jobId: 'm1' });
    await until(() => metrics.render().includes('outcome="completed"'));
    const text = metrics.render();
    expect(text).toContain('queue_jobs_total{queue="receipts",outcome="enqueued"} 1');
    expect(text).toContain('queue_jobs_total{queue="receipts",outcome="completed"} 1');
    expect(text).not.toContain('99999');
    metrics.close();
  });
});
