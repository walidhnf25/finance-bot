/**
 * The receipt photo path with the background queue switched ON: the real NestJS app, a real HTTP webhook, real
 * PostgreSQL (finance_bot_test) and a real Redis (database 15). Only Telegram's outbound HTTP (a capturing fake)
 * and the OCR engine (a stub) are substituted.
 *
 * What must hold with the queue on, exactly as without it: a photo never records money by itself, a
 * redelivered or re-run job never makes a second draft or transaction, and a Redis outage never costs the
 * user a receipt.
 */
import sharp from 'sharp';
import request from 'supertest';
import type { Server } from 'node:http';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ReceiptJobHandler } from 'src/modules/bot/application/receipt-job.handler';
import { JobQueue, QUEUE_NAMES } from 'src/modules/queue/domain/job-queue';
import { BullJobQueue } from 'src/modules/queue/infrastructure/bull-job-queue';
import { ReceiptOcr } from 'src/modules/receipt/infrastructure/ocr';
import { MetricsService } from 'src/modules/observability/metrics.service';
import { resetDatabase } from '../setup/test-db';
import { buildUpdate, createTestApp, TestApp } from '../setup/test-app';
import { TEST_REDIS_URL } from './redis';

class StubOcr extends ReceiptOcr {
  text = 'WARUNG MAKAN\nNasi 10.000\nTeh 5.000\nTOTAL 15.000\nTUNAI 20.000';
  read(): Promise<string> {
    return Promise.resolve(this.text);
  }
}

const USER = 7101;
const png = (shade: number): Promise<Buffer> =>
  sharp({
    create: { width: 70 + shade, height: 50, channels: 3, background: { r: shade, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();

const until = async (check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not reached in time');
};

describe('receipt photos through the background queue', () => {
  const raw = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
  let t: TestApp;
  let prefix: string;
  const ocr = new StubOcr();
  let counter = 0;

  const boot = async (env: Record<string, string> = {}): Promise<void> => {
    prefix = `a${randomUUID().slice(0, 8)}:`;
    t = await createTestApp(
      {
        REDIS_URL: TEST_REDIS_URL,
        REDIS_KEY_PREFIX: prefix,
        RECEIPT_AI_MODE: 'never',
        RECEIPT_JOB_ATTEMPTS: '3',
        RECEIPT_JOB_BACKOFF_SECONDS: '1',
        ...env,
      },
      (b) => b.overrideProvider(ReceiptOcr).useValue(ocr),
    );
    await resetDatabase(t.prisma);
  };
  afterEach(async () => {
    await t?.close();
    const keys = await raw.keys(`${prefix}*`);
    if (keys.length) await raw.del(...keys);
    ocr.text = 'WARUNG MAKAN\nNasi 10.000\nTeh 5.000\nTOTAL 15.000\nTUNAI 20.000';
  });
  afterAll(async () => {
    await raw.quit();
  });

  const userId = async () =>
    (await t.prisma.user.findUniqueOrThrow({ where: { telegramId: String(USER) } })).id;
  const drafts = () => t.prisma.receiptDraft.count();
  const txCount = () => t.prisma.transaction.count();
  const texts = () => t.telegram.texts.map((m) => m.text);
  const photo = async (fileId: string, withFile = true) => {
    const bytes = await png(++counter);
    if (withFile) t.telegram.files.set(fileId, bytes);
    return buildUpdate(USER, '', undefined, {
      text: undefined,
      // the queue refuses jobs whose message time is far from now, so use the real clock here
      date: Math.floor(Date.now() / 1000),
      photo: [
        { file_id: fileId, file_unique_id: fileId, width: 70, height: 50, file_size: bytes.length },
      ],
    });
  };

  it('answers at once, reads in the background, and records nothing until "ya"', async () => {
    await boot();
    await t.say(USER, 'halo').expect(200);
    t.telegram.clear();

    await t.deliver(await photo('FILEID-OK-0001')).expect(200);
    expect(texts()[0]).toContain('Struk diterima'); // immediate acknowledgement

    await until(() => texts().some((m) => m.includes('Rp15.000')));
    expect(await drafts()).toBe(1);
    expect(await txCount()).toBe(0); // still only a draft

    await t.say(USER, 'ya').expect(200);
    expect(await txCount()).toBe(1);
    expect(await t.prisma.receiptDraft.count({ where: { status: 'CONFIRMED' } })).toBe(1);
  });

  it('a redelivered update (same message) is answered once and makes one draft', async () => {
    await boot();
    await t.say(USER, 'halo').expect(200);
    t.telegram.clear();
    const update = await photo('FILEID-DUP-0002');
    await t.deliver(update).expect(200);
    await t.deliver(update).expect(200); // Telegram redelivers the same update
    await until(() => texts().some((m) => m.includes('Rp15.000')));
    await new Promise((r) => setTimeout(r, 500));
    expect(texts().filter((m) => m.includes('Rp15.000'))).toHaveLength(1);
    expect(await drafts()).toBe(1);
    expect(await txCount()).toBe(0);
  });

  it('the SAME job run twice (at-least-once delivery) still leaves one draft and, after "ya", one transaction', async () => {
    await boot();
    await t.say(USER, 'halo').expect(200);
    t.telegram.clear();
    await t.deliver(await photo('FILEID-TWICE-003')).expect(200);
    await until(() => texts().some((m) => m.includes('Rp15.000')));

    // Re-run the exact payload the queue delivered: the second run must find the pending draft, not make one.
    const handler = t.app.get(ReceiptJobHandler);
    const id = await userId();
    const payload = {
      userId: id,
      chatId: String(USER),
      messageId: 'twice-1',
      fileId: 'FILEID-TWICE-003',
      receivedAt: new Date().toISOString(),
    };
    await handler.run(payload);
    await handler.run(payload);
    expect(await drafts()).toBe(1);
    expect(await txCount()).toBe(0);

    await t.say(USER, 'ya').expect(200);
    await t.say(USER, 'ya').expect(200);
    expect(await txCount()).toBe(1);
  });

  it('the SAME job running at the SAME time twice still leaves exactly one draft', async () => {
    await boot();
    await t.say(USER, 'halo').expect(200);
    t.telegram.clear();
    t.telegram.files.set('FILEID-PAR-00009', await png(++counter));
    const handler = t.app.get(ReceiptJobHandler);
    const payload = {
      userId: await userId(),
      chatId: String(USER),
      messageId: 'parallel-1',
      fileId: 'FILEID-PAR-00009',
      receivedAt: new Date().toISOString(),
    };
    await Promise.all([handler.run(payload), handler.run(payload), handler.run(payload)]);
    expect(await drafts()).toBe(1);
    expect(await txCount()).toBe(0);
    await t.say(USER, 'ya').expect(200);
    expect(await txCount()).toBe(1);
  });

  it('a job recovered long after it was sent still gives a draft the user can confirm', async () => {
    await boot();
    await t.say(USER, 'halo').expect(200);
    t.telegram.clear();
    t.telegram.files.set('FILEID-OLD-000010', await png(++counter));
    const sentSixHoursAgo = new Date(Date.now() - 6 * 3_600_000).toISOString();
    await t.app.get(JobQueue).enqueue(
      QUEUE_NAMES.receipts,
      'read',
      {
        userId: await userId(),
        chatId: String(USER),
        messageId: 'old-1',
        fileId: 'FILEID-OLD-000010',
        receivedAt: sentSixHoursAgo,
      },
      { jobId: 'old-1' },
    );
    await until(() => texts().some((m) => m.includes('Rp15.000')));
    await t.say(USER, 'ya').expect(200);
    expect(await txCount()).toBe(1); // the draft was alive, not born expired
  });

  it('retries a transient download failure and then delivers the draft', async () => {
    await boot();
    await t.say(USER, 'halo').expect(200);
    t.telegram.clear();
    await t.deliver(await photo('FILEID-LATE-0004', false)).expect(200); // the file is not downloadable yet
    await new Promise((r) => setTimeout(r, 400));
    expect(await drafts()).toBe(0);
    t.telegram.files.set('FILEID-LATE-0004', await png(++counter)); // Telegram "recovers"
    await until(() => texts().some((m) => m.includes('Rp15.000')), 30_000);
    expect(await drafts()).toBe(1);
  });

  it('tells the user when the retries are used up, and records nothing', async () => {
    await boot({ RECEIPT_JOB_ATTEMPTS: '2' });
    await t.say(USER, 'halo').expect(200);
    t.telegram.clear();
    await t.deliver(await photo('FILEID-GONE-0005', false)).expect(200); // never downloadable
    await until(() => texts().some((m) => m.includes('belum berhasil dibaca')), 30_000);
    expect(await drafts()).toBe(0);
    expect(await txCount()).toBe(0);
  });

  it('refuses a forged job: wrong chat, unknown user, extra fields, hostile ids — and writes to nobody', async () => {
    await boot();
    await t.say(USER, 'halo').expect(200);
    t.telegram.clear();
    const jobs = t.app.get(JobQueue);
    const id = await userId();
    const base = {
      userId: id,
      chatId: String(USER),
      messageId: 'forged-1',
      fileId: 'FILEID-FORGE-006',
      receivedAt: new Date().toISOString(),
    };
    const forged: object[] = [
      { ...base, chatId: '999999' }, // a stranger's chat
      { ...base, userId: randomUUID() }, // nobody we know
      { ...base, extra: 'admin' }, // a field we never write
      { ...base, fileId: '../../etc/passwd' },
      { ...base, receivedAt: '1999-01-01T00:00:00Z' },
      { ...base, chatId: '-100123456' }, // a group
    ];
    for (const [i, job] of forged.entries()) {
      await jobs.enqueue(QUEUE_NAMES.receipts, 'read', job, { jobId: `forged-${i}`, attempts: 3 });
    }
    const queue = t.app.get(BullJobQueue);
    await until(async () => (await queue.counts(QUEUE_NAMES.receipts)).failed === forged.length);
    expect(texts()).toHaveLength(0); // not a single message to anyone
    expect(await drafts()).toBe(0);
    expect(t.app.get(MetricsService).render()).toContain(
      'queue_jobs_total{queue="receipts",outcome="rejected"} 6',
    );
  });

  it('falls back to reading in-process when Redis is unreachable, so no receipt is lost', async () => {
    await boot({ REDIS_URL: 'redis://127.0.0.1:1/0' });
    await t.say(USER, 'halo').expect(200);
    t.telegram.clear();
    await t.deliver(await photo('FILEID-FALL-0007')).expect(200);
    expect(texts().some((m) => m.includes('Rp15.000'))).toBe(true); // answered synchronously
    expect(texts().some((m) => m.includes('Struk diterima'))).toBe(false);
    expect(await drafts()).toBe(1);
    expect(t.app.get(MetricsService).render()).toContain('outcome="fallback"');
  });

  it('an oversized photo is refused before it takes a queue slot', async () => {
    await boot();
    await t.say(USER, 'halo').expect(200);
    t.telegram.clear();
    const update = await photo('FILEID-BIG-00008');
    update.message!.photo![0].file_size = 50 * 1_048_576;
    await t.deliver(update).expect(200);
    expect(texts()[0]).toContain('terlalu besar');
    expect(
      (await t.app.get(BullJobQueue).counts(QUEUE_NAMES.receipts)).waiting +
        (await t.app.get(BullJobQueue).counts(QUEUE_NAMES.receipts)).active,
    ).toBe(0);
  });

  it('shows the queue in /health/ready: up with Redis, degraded (never down) without', async () => {
    await boot();
    const up = await t.app.get(JobQueue).check();
    expect(up.status).toBe('up');
    await t.close();

    await boot({ REDIS_URL: 'redis://127.0.0.1:1/0' });
    const res = await request(t.app.getHttpServer() as Server)
      .get('/health/ready')
      .set('Host', '127.0.0.1');
    const body = res.body as { status: string; checks: { queue: { status: string } } };
    expect(res.status).toBe(200); // PostgreSQL is fine: the app stays ready
    expect(body.checks.queue.status).toBe('degraded');
    expect(body.status).toBe('degraded');
  });
});
