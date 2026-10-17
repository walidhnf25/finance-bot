/**
 * CONTROLLED SOAK TEST against a SIMULATED Telegram transport and the real PostgreSQL test database.
 * It is NOT a stress test of Telegram and sends nothing to it.
 *
 *   npm run test:soak                       60 seconds (default)
 *   SOAK_SECONDS=1800 npm run test:soak     30 minutes
 *   SOAK_SEED=42 npm run test:soak          same failure pattern again
 *
 * For a fixed duration, a few simulated users record transactions, replay updates, and send receipt
 * photos (confirm / cancel) while failures are injected: PostgreSQL write errors, Telegram reply
 * errors, a failing model. It measures unexpected errors, recovery, throughput and heap growth, and
 * checks the invariants that matter: exactly one transaction per intended record, no duplicate
 * idempotency keys, receipt drafts linked to exactly one transaction, referential integrity.
 * Results are printed and written to soak-report.json (git-ignored).
 */
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { ReceiptOcr } from '../../src/modules/receipt/infrastructure/ocr';
import { TransactionRepository } from '../../src/modules/transaction/domain/transaction.repository';
import { ReceiptRepository } from '../../src/modules/receipt/domain/receipt.repository';
import { FakeOllama } from '../../src/testing/fake-ollama';
import { resetDatabase } from '../setup/test-db';
import { buildUpdate, createTestApp, E2E_DATE, TestApp } from '../setup/test-app';

const SECONDS = Number(process.env.SOAK_SECONDS ?? 60);
const SEED = Number(process.env.SOAK_SEED ?? Date.now() % 100000);
/** Simulated restart (new application instance, same database) every this many iterations. */
const RESTART_EVERY = Number(process.env.SOAK_RESTART_EVERY ?? 250);
const USERS = Array.from({ length: 30 }, (_, i) => 9000 + i);

/** Small seeded PRNG so a failing run can be reproduced. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class StubOcr extends ReceiptOcr {
  read(): Promise<string> {
    return Promise.resolve('WARUNG SOAK\nNasi 10.000\nTOTAL 12.500\nTUNAI 20.000');
  }
}

const heapMb = (): number => {
  (globalThis as { gc?: () => void }).gc?.();
  return Math.round(process.memoryUsage().heapUsed / 1_048_576);
};

describe(`soak (${SECONDS}s, seed ${SEED})`, () => {
  let t: TestApp;
  let fake: FakeOllama;

  /** A fresh application instance: empty memory, same database (what a restart looks like). */
  const boot = (): Promise<TestApp> =>
    createTestApp(
      {
        AI_PROVIDER: 'ollama',
        OLLAMA_BASE_URL: fake.baseUrl,
        OLLAMA_TIMEOUT_MS: '2000',
        RECEIPT_MAX_PER_HOUR: '1000', // the per-user hourly limit has its own tests
      },
      (b) => b.overrideProvider(ReceiptOcr).useValue(new StubOcr()),
    );

  beforeAll(async () => {
    fake = new FakeOllama({
      models: [{ name: 'soak-model', capabilities: ['completion'] }],
      chatReply: JSON.stringify({
        merchant: 'Warung Soak',
        date: E2E_DATE,
        total: 12500,
        items: [],
        categoryHint: 'makan',
      }),
    });
    await fake.start();
    t = await boot();
    await resetDatabase(t.prisma);
  });
  afterAll(async () => {
    await t.close();
    await fake.stop();
  });

  it('keeps every invariant while failures are injected', async () => {
    const rand = mulberry32(SEED);
    const stats = {
      iterations: 0,
      recordsIntended: 0,
      receiptsConfirmAttempts: 0,
      receiptsCancelled: 0,
      http503Injected: 0,
      http503Unexpected: 0,
      httpOther: 0,
      redeliveries: 0,
      duplicateReplays: 0,
      telegramReplyFailures: 0,
      modelFailures: 0,
      restarts: 0,
      replaysAfterRestart: 0,
    };
    const heap: Array<{ at: number; mb: number }> = [{ at: 0, mb: heapMb() }];

    // Failure injection (re-installed on every restarted instance) ----------------------------
    let injectNext = false;
    let injectConfirm = false;
    const installInjection = (): void => {
      const txRepo = t.app.get(TransactionRepository);
      const originalCreate = txRepo.create.bind(txRepo);
      jest.spyOn(txRepo, 'create').mockImplementation((input) => {
        if (injectNext) {
          injectNext = false;
          stats.http503Injected += 1;
          return Promise.reject(new Error('injected database failure'));
        }
        return originalCreate(input);
      });
      const receiptRepo = t.app.get(ReceiptRepository);
      const originalConfirm = receiptRepo.confirm.bind(receiptRepo);
      jest.spyOn(receiptRepo, 'confirm').mockImplementation((...args) => {
        if (injectConfirm) {
          injectConfirm = false;
          stats.http503Injected += 1;
          return Promise.reject(new Error('injected database failure'));
        }
        return originalConfirm(...args);
      });
    };
    installInjection();
    /** The last accepted updates: redelivered after a restart, which must change nothing. */
    const recentlyAccepted: Array<ReturnType<typeof buildUpdate>> = [];
    const restart = async (): Promise<void> => {
      await t.close();
      t = await boot();
      installInjection();
      stats.restarts += 1;
      for (const update of recentlyAccepted) {
        stats.replaysAfterRestart += 1;
        const res = await t.deliver(update);
        if (res.status !== 200) stats.httpOther += 1;
      }
    };

    /** Deliver, redelivering on 503 like Telegram does. Returns true when finally accepted (200). */
    const deliver = async (update: ReturnType<typeof buildUpdate>, injected: boolean) => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const res = await t.deliver(update);
        if (res.status === 200) return true;
        if (res.status === 503) {
          // Only the first attempt of a deliberately failed delivery may be refused.
          if (!(injected && attempt === 1)) stats.http503Unexpected += 1;
          stats.redeliveries += 1;
          continue;
        }
        stats.httpOther += 1;
        return false;
      }
      return false;
    };

    for (const u of USERS) await deliver(buildUpdate(u, 'halo'), false);

    const started = Date.now();
    const lastSample = { at: started };
    let n = 0;
    while (Date.now() - started < SECONDS * 1000) {
      const user = USERS[Math.floor(rand() * USERS.length)];
      const roll = rand();
      stats.iterations += 1;
      n += 1;

      if (roll < 0.55) {
        // a plain record, sometimes with a database failure on the first attempt
        const inject = rand() < 0.2;
        injectNext = inject;
        const update = buildUpdate(user, `beli soak${n} ${1 + Math.floor(rand() * 90)}rb`);
        if (await deliver(update, inject)) {
          stats.recordsIntended += 1;
          recentlyAccepted.push(update);
          if (recentlyAccepted.length > 12) recentlyAccepted.shift();
        }
        injectNext = false;
        if (rand() < 0.3) {
          stats.duplicateReplays += 1; // Telegram redelivering an update we already handled
          await deliver(update, false);
        }
      } else if (roll < 0.65) {
        await deliver(buildUpdate(user, 'ringkasan bulan ini'), false);
      } else if (roll < 0.7) {
        // Telegram cannot be reached while replying: the update is redelivered later
        t.telegram.failSends = true;
        const update = buildUpdate(user, `beli soak${n} 5rb`);
        const first = await t.deliver(update);
        t.telegram.failSends = false;
        if (first.status === 503) {
          stats.telegramReplyFailures += 1;
          stats.redeliveries += 1;
        }
        if (await deliver(update, false)) stats.recordsIntended += 1;
      } else {
        // receipt photo, then confirm (with a database failure sometimes) or cancel
        // Raw pixels carry the counter, so every photo is a different image (a different hash).
        const pixels = Buffer.alloc(64 * 64 * 3, 200);
        pixels.writeUInt32BE(n, 0);
        const bytes = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } })
          .png()
          .toBuffer();
        const fileId = `soak-photo-${n}`;
        t.telegram.files.set(fileId, bytes);
        if (rand() < 0.15) {
          fake.options.chatStatus = 500; // a failing model: the deterministic reader takes over
          stats.modelFailures += 1;
        }
        const photo = buildUpdate(user, '', undefined, {
          text: undefined,
          photo: [
            {
              file_id: fileId,
              file_unique_id: fileId,
              width: 60,
              height: 40,
              file_size: bytes.length,
            },
          ],
        });
        const accepted = await deliver(photo, false);
        delete fake.options.chatStatus;
        t.telegram.files.delete(fileId);
        if (accepted) {
          if (rand() < 0.75) {
            const inject = rand() < 0.25;
            injectConfirm = inject;
            if (await deliver(buildUpdate(user, 'ya'), inject)) stats.receiptsConfirmAttempts += 1;
            injectConfirm = false;
            await deliver(buildUpdate(user, 'ya'), false); // pressing it again must change nothing
          } else {
            await deliver(buildUpdate(user, 'batal'), false);
            stats.receiptsCancelled += 1;
          }
        }
      }

      if (n % RESTART_EVERY === 0) await restart();

      if (Date.now() - lastSample.at >= 5_000) {
        lastSample.at = Date.now();
        // The harness itself would otherwise grow: the fake Telegram keeps every message it was asked to
        // send, the fake Ollama every request, and Jest every mock call. Clearing them each sample keeps
        // the heap curve about the application, not about the test tooling.
        t.telegram.clear();
        fake.requests.length = 0;
        jest.clearAllMocks();
        heap.push({ at: Math.round((Date.now() - started) / 1000), mb: heapMb() });
      }
    }
    heap.push({ at: Math.round((Date.now() - started) / 1000), mb: heapMb() });
    const elapsed = (Date.now() - started) / 1000;

    // Invariants ---------------------------------------------------------------------------------
    const soakRows = await t.prisma.transaction.count({
      where: { description: { startsWith: 'soak' } },
    });
    const receiptRows = await t.prisma.transaction.count({
      where: { sourceMessage: 'foto struk' },
    });
    const dupKeys = await t.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM (SELECT user_id, idempotency_key FROM transactions
        WHERE idempotency_key IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) d`;
    const confirmedDrafts = await t.prisma.receiptDraft.count({ where: { status: 'CONFIRMED' } });
    const orphanConfirmed = await t.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM receipt_drafts r LEFT JOIN transactions x ON x.id = r.transaction_id
      WHERE r.status = 'CONFIRMED' AND x.id IS NULL`;
    const orphanTx = await t.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM transactions x LEFT JOIN users u ON u.id = x.user_id WHERE u.id IS NULL`;

    const half = Math.floor(heap.length / 2);
    const early = Math.min(...heap.slice(0, Math.max(2, half)).map((h) => h.mb));
    const late = Math.max(...heap.slice(half).map((h) => h.mb));
    const report = {
      at: new Date().toISOString(),
      seconds: Math.round(elapsed),
      seed: SEED,
      transport: 'simulated (no Telegram traffic)',
      stats,
      throughputPerSecond: Number((stats.iterations / elapsed).toFixed(2)),
      database: { soakRows, receiptRows, confirmedDrafts },
      heapMb: {
        samples: heap,
        startMb: heap[0].mb,
        endMb: heap[heap.length - 1].mb,
        earlyMinMb: early,
        lateMaxMb: late,
      },
      gcExposed: typeof (globalThis as { gc?: unknown }).gc === 'function',
    };
    writeFileSync('soak-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));

    expect(stats.httpOther).toBe(0); // nothing but 200 and the injected 503s
    expect(stats.http503Unexpected).toBe(0);
    expect(soakRows).toBe(stats.recordsIntended); // exactly one row per intended record
    // Every confirmed draft is linked to exactly one transaction and the other way round. A photo
    // can legitimately end without a draft (hourly limit, unreadable), so this is <=, not ==.
    expect(receiptRows).toBe(confirmedDrafts);
    expect(receiptRows).toBeLessThanOrEqual(stats.receiptsConfirmAttempts);
    expect(Number(dupKeys[0].n)).toBe(0);
    expect(Number(orphanConfirmed[0].n)).toBe(0);
    expect(Number(orphanTx[0].n)).toBe(0);
  });
});
