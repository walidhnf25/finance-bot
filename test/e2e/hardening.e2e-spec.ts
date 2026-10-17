/**
 * END-TO-END hardening through the real HTTP webhook boundary, real NestJS app, real PostgreSQL test
 * database. Only the outbound Telegram HTTP calls (a capturing fake) and, where stated, the
 * Ollama server (a fake HTTP server) and the OCR engine (a stub) are substituted. Nothing here
 * proves the behaviour of Telegram itself; see docs/testing/telegram-real-integration-checklist.md.
 *
 * Covers: PostgreSQL failures at the write stage and at receipt confirmation (with recovery on
 * redelivery), AI provider timeouts, Telegram file-download failures, unauthorized users, and
 * month/year boundaries with explicit clocks.
 */
import sharp from 'sharp';
import { ReceiptOcr } from '../../src/modules/receipt/infrastructure/ocr';
import { ReceiptRepository } from '../../src/modules/receipt/domain/receipt.repository';
import { TransactionRepository } from '../../src/modules/transaction/domain/transaction.repository';
import { FakeOllama } from '../../src/testing/fake-ollama';
import { resetDatabase } from '../setup/test-db';
import { buildUpdate, createTestApp, E2E_DATE, TestApp } from '../setup/test-app';

class StubOcr extends ReceiptOcr {
  text = 'WARUNG MAKAN\nNasi 10.000\nTeh 5.000\nTOTAL 15.000\nTUNAI 20.000';
  read(): Promise<string> {
    return Promise.resolve(this.text);
  }
}

const USER = 7001;
const seconds = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

const png = (shade: number): Promise<Buffer> =>
  sharp({
    create: { width: 70 + shade, height: 50, channels: 3, background: { r: shade, g: 20, b: 20 } },
  })
    .png()
    .toBuffer();

describe('hardening (end to end)', () => {
  describe('failures and recovery', () => {
    let t: TestApp;
    let fake: FakeOllama;
    const ocr = new StubOcr();
    let counter = 0;

    beforeAll(async () => {
      fake = new FakeOllama({
        models: [{ name: 'test-model', capabilities: ['completion'] }],
        chatReply: JSON.stringify({
          merchant: 'Warung Makan',
          date: E2E_DATE,
          total: 15000,
          items: [],
          categoryHint: 'makan',
        }),
      });
      await fake.start();
      t = await createTestApp(
        {
          AI_PROVIDER: 'ollama',
          RECEIPT_AI_MODE: 'always',
          OLLAMA_BASE_URL: fake.baseUrl,
          OLLAMA_MODEL: '',
          OLLAMA_TIMEOUT_MS: '1200', // keep the "model never answers" case short
          OLLAMA_BREAKER_COOLDOWN_SECONDS: '1', // the failures below open the breaker; keep its pause short
        },
        (b) => b.overrideProvider(ReceiptOcr).useValue(ocr),
      );
    });
    afterAll(async () => {
      await t.close();
      await fake.stop();
    });
    beforeEach(async () => {
      await resetDatabase(t.prisma);
      t.telegram.clear();
      t.telegram.files.clear();
      fake.requests.length = 0;
      delete fake.options.chatHang;
      delete fake.options.chatStatus;
      ocr.text = 'WARUNG MAKAN\nNasi 10.000\nTeh 5.000\nTOTAL 15.000\nTUNAI 20.000';
      jest.restoreAllMocks();
    });

    const userId = async () =>
      (await t.prisma.user.findUniqueOrThrow({ where: { telegramId: String(USER) } })).id;
    const txCount = async () => t.prisma.transaction.count({ where: { userId: await userId() } });
    const photoUpdate = async (fileId: string) => {
      const bytes = await png(++counter);
      t.telegram.files.set(fileId, bytes);
      return buildUpdate(USER, '', undefined, {
        text: undefined,
        photo: [
          {
            file_id: fileId,
            file_unique_id: fileId,
            width: 70,
            height: 50,
            file_size: bytes.length,
          },
        ],
      });
    };
    const lastText = () => t.telegram.last(String(USER));

    describe('PostgreSQL fails while recording a transaction', () => {
      it('answers 503, stores nothing, and the redelivery stores exactly one', async () => {
        await t.say(USER, 'halo').expect(200);
        const repo = t.app.get(TransactionRepository);
        jest.spyOn(repo, 'create').mockRejectedValueOnce(new Error('connection lost'));

        const update = buildUpdate(USER, 'beli kopi 25rb');
        await t.deliver(update).expect(503);
        expect(await txCount()).toBe(0);

        await t.deliver(update).expect(200);
        expect(await txCount()).toBe(1);
        await t.deliver(update).expect(200); // a late duplicate delivery
        expect(await txCount()).toBe(1);
      });
    });

    describe('PostgreSQL fails around receipt drafts and confirmation', () => {
      it('a failed draft write is retried and yields exactly one draft', async () => {
        await t.say(USER, 'halo').expect(200);
        const repo = t.app.get(ReceiptRepository);
        jest.spyOn(repo, 'createDraft').mockRejectedValueOnce(new Error('connection lost'));

        const update = await photoUpdate('photo-db-1');
        await t.deliver(update).expect(503);
        expect(await t.prisma.receiptDraft.count()).toBe(0);

        await t.deliver(update).expect(200);
        expect(await t.prisma.receiptDraft.count()).toBe(1);
        expect(lastText()).toContain('Saya membaca struk ini');
      });

      it('a failed confirmation leaves the draft pending; the retry records it once', async () => {
        await t.say(USER, 'halo').expect(200);
        await t.deliver(await photoUpdate('photo-db-2')).expect(200);
        expect(await txCount()).toBe(0);

        const repo = t.app.get(ReceiptRepository);
        jest.spyOn(repo, 'confirm').mockRejectedValueOnce(new Error('connection lost'));
        const yes = buildUpdate(USER, 'ya');

        await t.deliver(yes).expect(503);
        expect(await txCount()).toBe(0);
        expect((await t.prisma.receiptDraft.findFirstOrThrow()).status).toBe('PENDING');

        await t.deliver(yes).expect(200); // Telegram redelivers the same update
        expect(lastText()).toContain('Berhasil dicatat');
        expect(await txCount()).toBe(1);

        await t.say(USER, 'ya').expect(200); // pressing it again later
        expect(await txCount()).toBe(1);
        expect((await t.prisma.receiptDraft.findFirstOrThrow()).status).toBe('CONFIRMED');
      });

      it('cancelling one draft and confirming another creates exactly one transaction', async () => {
        await t.say(USER, 'halo').expect(200);
        await t.deliver(await photoUpdate('photo-a')).expect(200);
        await t.say(USER, 'batal').expect(200);
        expect(await txCount()).toBe(0);

        await t.deliver(await photoUpdate('photo-b')).expect(200);
        await t.say(USER, 'ya').expect(200);
        expect(await txCount()).toBe(1);
        const statuses = (
          await t.prisma.receiptDraft.findMany({ orderBy: { createdAt: 'asc' } })
        ).map((d) => d.status);
        expect(statuses).toEqual(['CANCELLED', 'CONFIRMED']);
      });
    });

    describe('Telegram file download fails', () => {
      it('is retried: 503 first, then one draft', async () => {
        await t.say(USER, 'halo').expect(200);
        const update = await photoUpdate('photo-dl');
        jest.spyOn(t.telegram, 'downloadFile').mockRejectedValueOnce(new Error('network'));

        await t.deliver(update).expect(503);
        expect(await t.prisma.receiptDraft.count()).toBe(0);
        await t.deliver(update).expect(200);
        expect(await t.prisma.receiptDraft.count()).toBe(1);
      });
    });

    describe('the AI provider misbehaves', () => {
      it('a model that never answers is cut off by the timeout; OCR text still yields a draft', async () => {
        await t.say(USER, 'halo').expect(200);
        fake.options.chatHang = true;

        const started = Date.now();
        await t.deliver(await photoUpdate('photo-hang')).expect(200);
        expect(Date.now() - started).toBeLessThan(8_000);

        expect(lastText()).toContain('Rp15.000');
        expect(await t.prisma.receiptDraft.count()).toBe(1);
        expect(await txCount()).toBe(0); // still only a draft
      });

      it('with a hung model and no labelled total nothing is fabricated', async () => {
        await t.say(USER, 'halo').expect(200);
        fake.options.chatHang = true;
        ocr.text = 'WARUNG MAKAN\nNasi 10.000\nTeh 5.000';

        await t.deliver(await photoUpdate('photo-hang-2')).expect(200);
        expect(lastText()).toContain('belum bisa membaca');
        expect(await t.prisma.receiptDraft.count()).toBe(0);
        expect(await txCount()).toBe(0);
      });

      it('recovers on the next photo once the model is back', async () => {
        await t.say(USER, 'halo').expect(200);
        fake.options.chatStatus = 500;
        await t.deliver(await photoUpdate('photo-bad-ai')).expect(200);
        expect(await t.prisma.receiptDraft.count()).toBe(1); // deterministic reader

        delete fake.options.chatStatus;
        await t.say(USER, 'batal').expect(200);
        // Three failures in a row (hang, hang, 500) opened the breaker: it lets one probe through after its pause.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        await t.deliver(await photoUpdate('photo-good-ai')).expect(200);
        expect(lastText()).toContain('Warung Makan'); // structured by the model this time
      });
    });
  });

  describe('RECEIPT_AI_MODE=auto (the default)', () => {
    let t: TestApp;
    let fake: FakeOllama;
    const ocr = new StubOcr();
    const U = 7400;

    beforeAll(async () => {
      fake = new FakeOllama({
        models: [{ name: 'test-model', capabilities: ['completion'] }],
        chatReply: JSON.stringify({
          merchant: 'Warung Makan',
          date: E2E_DATE,
          total: 15000,
          items: [],
          categoryHint: 'makan',
        }),
      });
      await fake.start();
      t = await createTestApp(
        { AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: fake.baseUrl, RECEIPT_AI_MODE: 'auto' },
        (b) => b.overrideProvider(ReceiptOcr).useValue(ocr),
      );
    });
    afterAll(async () => {
      await t.close();
      await fake.stop();
    });
    beforeEach(async () => {
      await resetDatabase(t.prisma);
      t.telegram.clear();
      t.telegram.files.clear();
      fake.requests.length = 0;
    });

    const sendPhoto = async (shade: number) => {
      const bytes = await png(shade);
      const id = 'auto-' + shade;
      t.telegram.files.set(id, bytes);
      await t
        .deliver(
          buildUpdate(U, '', undefined, {
            text: undefined,
            photo: [
              { file_id: id, file_unique_id: id, width: 70, height: 50, file_size: bytes.length },
            ],
          }),
        )
        .expect(200);
    };
    const modelAsked = () => fake.requests.some((r) => r.path === '/api/chat');

    it('a clear printed total is read by code: fast, and the model is never asked', async () => {
      await t.deliver(buildUpdate(U, 'halo')).expect(200);
      ocr.text = 'WARUNG MAKAN\nNasi 10.000\nTeh 5.000\nTOTAL 15.000\nTUNAI 20.000\nKEMBALI 5.000';
      const started = Date.now();
      await sendPhoto(11);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(modelAsked()).toBe(false);
      expect(t.telegram.last(String(U))).toContain('Rp15.000');
      expect(await t.prisma.receiptDraft.count()).toBe(1);
    });

    it('with no total line the model is asked, and its guess is flagged', async () => {
      await t.deliver(buildUpdate(U, 'halo')).expect(200);
      ocr.text = 'WARUNG MAKAN\nNasi 10.000\nTeh 5.000\n15.000';
      await sendPhoto(12);
      expect(modelAsked()).toBe(true);
      expect(t.telegram.last(String(U))).toContain('ditebak');
    });
  });

  describe('unauthorized users', () => {
    let t: TestApp;
    const ocr = new StubOcr();
    const ALLOWED = 7100;
    const STRANGER = 7200;

    beforeAll(async () => {
      t = await createTestApp(
        {
          TELEGRAM_ALLOW_PUBLIC: 'false',
          TELEGRAM_ALLOWED_USER_IDS: String(ALLOWED),
          AI_PROVIDER: 'none',
        },
        (b) => b.overrideProvider(ReceiptOcr).useValue(ocr),
      );
    });
    afterAll(async () => t.close());
    beforeEach(async () => {
      await resetDatabase(t.prisma);
      t.telegram.clear();
      jest.restoreAllMocks();
    });

    it('a stranger gets no reply, no user row, and their photo is never downloaded', async () => {
      const download = jest.spyOn(t.telegram, 'downloadFile');
      const bytes = await png(40);
      t.telegram.files.set('stranger-photo', bytes);

      await t.deliver(buildUpdate(STRANGER, 'beli kopi 25rb')).expect(200);
      await t
        .deliver(
          buildUpdate(STRANGER, '', undefined, {
            text: undefined,
            photo: [
              {
                file_id: 'stranger-photo',
                file_unique_id: 'x',
                width: 70,
                height: 50,
                file_size: bytes.length,
              },
            ],
          }),
        )
        .expect(200);

      expect(t.telegram.texts).toHaveLength(0);
      expect(download).not.toHaveBeenCalled();
      expect(await t.prisma.user.count()).toBe(0);
      expect(await t.prisma.transaction.count()).toBe(0);
      expect(await t.prisma.receiptDraft.count()).toBe(0);
    });

    it('the allowed user still works in the same app', async () => {
      await t.deliver(buildUpdate(ALLOWED, 'beli kopi 25rb')).expect(200);
      expect(await t.prisma.transaction.count()).toBe(1);
    });
  });

  describe('calendar boundaries (explicit clocks, Asia/Jakarta = UTC+7)', () => {
    let t: TestApp;
    const U = 7300;

    beforeAll(async () => {
      t = await createTestApp({ AI_PROVIDER: 'none' });
    });
    afterAll(async () => t.close());
    beforeEach(async () => {
      await resetDatabase(t.prisma);
      t.telegram.clear();
    });

    const sayAt = async (text: string, iso: string): Promise<string> => {
      t.telegram.clear();
      await t.deliver(buildUpdate(U, text, undefined, { date: seconds(iso) })).expect(200);
      return t.telegram.texts.map((m) => m.text).join('\n---\n');
    };

    it('month end: 23:30 on Jan 31 counts for January, 00:30 on Feb 1 for February', async () => {
      await sayAt('halo', '2026-01-31T16:00:00Z');
      await sayAt('beli kopi 25rb', '2026-01-31T16:30:00Z'); // 31 Jan 23:30 Jakarta
      await sayAt('beli teh 10rb', '2026-01-31T17:30:00Z'); //  1 Feb 00:30 Jakarta

      const january = await sayAt('ringkasan bulan ini', '2026-01-31T16:59:00Z');
      expect(january).toContain('Pengeluaran: Rp25.000');
      expect(january).not.toContain('Rp35.000');

      const february = await sayAt('ringkasan bulan ini', '2026-01-31T17:40:00Z');
      expect(february).toContain('Pengeluaran: Rp10.000');
      expect(february).not.toContain('Rp35.000');
    });

    it('year end: 23:30 on Dec 31 belongs to the old year, 00:30 on Jan 1 to the new one', async () => {
      await sayAt('halo', '2026-12-31T16:00:00Z');
      await sayAt('beli kopi 25rb', '2026-12-31T16:30:00Z'); // 31 Dec 2026 23:30 Jakarta
      await sayAt('beli teh 10rb', '2026-12-31T17:30:00Z'); //  1 Jan 2027 00:30 Jakarta

      const december = await sayAt('ringkasan bulan ini', '2026-12-31T16:59:00Z');
      expect(december).toContain('Pengeluaran: Rp25.000');

      const january = await sayAt('ringkasan bulan ini', '2026-12-31T17:40:00Z');
      expect(january).toContain('Pengeluaran: Rp10.000');
      expect(january).not.toContain('Rp35.000');
    });

    it('a leap day is a real day: 29 Feb 2028 is recorded on that date', async () => {
      await sayAt('halo', '2028-02-29T05:00:00Z');
      await sayAt('beli kopi 25rb', '2028-02-29T05:00:00Z');
      const row = await t.prisma.transaction.findFirstOrThrow();
      const jakarta = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(row.occurredAt);
      expect(jakarta).toBe('2028-02-29');
    });
  });
});
