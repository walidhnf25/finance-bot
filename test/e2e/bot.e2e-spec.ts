/**
 * END-TO-END through the real HTTP webhook boundary, real NestJS app, real PostgreSQL test
 * database. Only the outbound Telegram HTTP calls are replaced (captured), so nothing here proves
 * the behaviour of Telegram itself.
 */
import { Logger } from '@nestjs/common';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import { AuditLogRepository } from '../../src/modules/audit/domain/audit-log.repository';
import { UserRepository } from '../../src/modules/user/domain/user.repository';
import { PrismaService } from '../../src/database/prisma.service';
import { resetDatabase } from '../setup/test-db';
import { buildUpdate, createTestApp, TestApp } from '../setup/test-app';
import request from 'supertest';

const httpOf = (app: TestApp) => request(app.app.getHttpServer() as Server);

const A = 1001;
const B = 2002;

describe('Finance bot (end to end)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.telegram.clear();
    t.telegram.failSends = false;
  });

  const rowsOf = async (telegramId: number) => {
    const user = await t.prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
    return user
      ? t.prisma.transaction.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } })
      : [];
  };
  const say = async (user: number, text: string): Promise<string> => {
    t.telegram.clear();
    await t.say(user, text).expect(200);
    return t.telegram.texts.map((m) => m.text).join('\n---\n');
  };

  describe('a new user, from first message to export', () => {
    it('onboards, sets wallets, records, transfers and reports with consistent numbers', async () => {
      // 1. first message: onboarding + reply + the wallet question
      const first = await say(A, 'halo');
      expect(first).toContain('Selamat datang');
      expect(first).toContain('Mau pakai dompet yang mana');

      // 2. choose both wallets, then answer the two opening-balance questions
      expect(await say(A, '3')).toContain('Berapa saldo');
      expect(await say(A, '34rb')).toContain('Digital');
      expect(await say(A, '522rb')).toContain('Siap!');

      // 3. an expense that names its wallet
      expect(await say(A, 'beli cincau 20rb digital')).toContain('Berhasil dicatat');

      // 4. a multi-item message: one wallet question for the batch, then both are stored
      const ask = await say(A, 'beli ayam 8 ribu, beli es teh manis 5 ribu');
      expect(ask).toContain('Pakai dompet apa untuk 2 transaksi');
      expect(await say(A, 'cash')).toContain('2 transaksi dicatat');

      // 5. a transfer (ATM withdrawal)
      expect(await say(A, 'tarik tunai 100rb')).toContain('Transfer dicatat');

      // balances: cash 34.000 - 13.000 + 100.000 ; digital 522.000 - 20.000 - 100.000
      const saldo = await say(A, 'saldo');
      expect(saldo).toContain('Rp121.000');
      expect(saldo).toContain('Rp402.000');
      expect(saldo).toContain('Rp523.000');

      // the monthly summary reconciles with it
      const summary = await say(A, 'ringkasan bulan ini');
      expect(summary).toContain('Pemasukan: Rp556.000');
      expect(summary).toContain('Pengeluaran: Rp33.000');
      expect(summary).toContain('Total saldo dompet: *Rp523.000*');

      // database truth, exact to the minor unit
      const rows = await rowsOf(A);
      expect(rows.map((r) => r.amountMinor)).toEqual([
        3_400_000n, // opening cash
        52_200_000n, // opening digital
        2_000_000n, // cincau
        800_000n, // ayam
        500_000n, // es teh
      ]);
      expect(rows.map((r) => r.wallet)).toEqual(['CASH', 'DIGITAL', 'DIGITAL', 'CASH', 'CASH']);

      // 6. the Excel export carries the same data
      t.telegram.clear();
      await t.say(A, 'export bulan ini').expect(200);
      expect(t.telegram.documents).toHaveLength(1);
      expect(t.telegram.documents[0].filename).toMatch(/\.xlsx$/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(t.telegram.documents[0].content as never);
      const sheet = wb.getWorksheet('Transaksi')!;
      const text = JSON.stringify(sheet.getSheetValues());
      expect(text).toContain('cincau');
      expect(text).toContain('Saldo Awal');
    });

    it('treats a delivered update that is replayed (e.g. after a restart) as already handled', async () => {
      await say(A, 'halo');
      const update = buildUpdate(A, 'beli kopi 25rb', 777001);
      await t.deliver(update).expect(200);
      await t.deliver(update).expect(200); // same Telegram message again

      // A brand-new process has an empty in-memory cache: the DATABASE key must still stop it.
      const restarted = await createTestApp();
      try {
        await restarted.deliver(update).expect(200);
      } finally {
        await restarted.close();
      }
      expect((await rowsOf(A)).filter((r) => r.description === 'kopi')).toHaveLength(1);
    });

    it('rejects absurd amounts before storing anything', async () => {
      await say(A, 'halo');
      const reply = await say(A, 'beli mobil 99999999999999 juta');
      expect(reply).toContain('terlalu besar');
      expect(await rowsOf(A)).toHaveLength(0);
    });
  });

  describe('webhook security', () => {
    it('rejects a missing or wrong secret and accepts the right one', async () => {
      const update = buildUpdate(A, 'halo');
      await t.deliver(update, { 'x-telegram-bot-api-secret-token': '' }).expect(401);
      await t.deliver(update, { 'x-telegram-bot-api-secret-token': 'wrong' }).expect(401);
      await t.deliver(update, { 'x-telegram-bot-api-secret-token': t.secret + 'x' }).expect(401);
      expect(await t.prisma.user.count()).toBe(0); // nothing was processed

      await t.deliver(update).expect(200);
      expect(await t.prisma.user.count()).toBe(1);
    });

    it('rejects a body that is not a Telegram update', async () => {
      await t.deliver({ hello: 'world' } as never).expect(400);
    });

    it('does not accept webhook calls at all in polling mode', async () => {
      const polling = await createTestApp({
        TELEGRAM_POLLING: 'true',
        TELEGRAM_WEBHOOK_SECRET: '',
      });
      try {
        await polling.deliver(buildUpdate(A, 'halo')).expect(404);
        expect(await t.prisma.user.count()).toBe(0);
      } finally {
        await polling.close();
      }
    });
  });

  describe('access policy', () => {
    it('ignores everyone who is not on the allowlist', async () => {
      const restricted = await createTestApp({
        TELEGRAM_ALLOWED_USER_IDS: '111',
        TELEGRAM_ALLOW_PUBLIC: 'false',
      });
      try {
        await restricted.say(222, 'beli kopi 25rb').expect(200);
        expect(restricted.telegram.texts).toHaveLength(0); // no reply, no hint that the bot exists
        expect(await t.prisma.user.count()).toBe(0);

        await restricted.say(111, 'halo').expect(200);
        expect(restricted.telegram.texts.length).toBeGreaterThan(0);
        expect(await t.prisma.user.count()).toBe(1);
      } finally {
        await restricted.close();
      }
    });

    it('refuses to start when the policy is not explicit (empty allowlist, not public)', async () => {
      await expect(
        createTestApp({ TELEGRAM_ALLOWED_USER_IDS: '', TELEGRAM_ALLOW_PUBLIC: 'false' }),
      ).rejects.toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
    });

    it('refuses to start in webhook mode without a secret', async () => {
      await expect(createTestApp({ TELEGRAM_WEBHOOK_SECRET: '' })).rejects.toThrow(
        /TELEGRAM_WEBHOOK_SECRET/,
      );
    });
  });

  describe('users are isolated from each other', () => {
    it("never shows, changes or deletes another user's data", async () => {
      await say(A, 'halo');
      await say(A, 'beli kopi 25rb');
      await say(A, 'beli bensin 50rb');
      await say(B, 'halo');

      // B sees nothing of A's money
      const summaryB = await say(B, 'ringkasan bulan ini');
      expect(summaryB).toContain('Pemasukan: Rp0');
      expect(summaryB).toContain('Pengeluaran: Rp0');
      expect(summaryB).not.toContain('75.000');

      // B's "hapus" has nothing to delete, and A's rows stay
      expect(await say(B, 'hapus')).toContain('Belum ada transaksi');
      expect(await rowsOf(A)).toHaveLength(2);

      // B resets: A is untouched
      await say(B, 'beli teh 5rb');
      await say(B, 'reset');
      await say(B, 'ya');
      expect(await rowsOf(B)).toHaveLength(0);
      expect(await rowsOf(A)).toHaveLength(2);
    });

    it('resets only the requesting user, after confirmation', async () => {
      await say(A, 'halo');
      await say(A, 'beli kopi 25rb');
      expect(await say(A, 'reset')).toContain('Yakin mau reset');
      expect(await rowsOf(A)).toHaveLength(1); // not yet: it asked first
      expect(await say(A, 'tidak')).toContain('dibatalkan');
      expect(await rowsOf(A)).toHaveLength(1);

      await say(A, 'reset');
      expect(await say(A, 'ya')).toContain('direset');
      expect(await rowsOf(A)).toHaveLength(0);
    });
  });

  describe('failure recovery', () => {
    const failing = (n: number) => {
      const users = t.app.get(UserRepository);
      const spy = jest.spyOn(users, 'findOrCreate');
      for (let i = 0; i < n; i++) spy.mockRejectedValueOnce(new Error('database is down'));
      return spy;
    };

    it('answers 503 so Telegram redelivers, and the redelivery succeeds exactly once', async () => {
      const spy = failing(1);
      const update = buildUpdate(A, 'beli kopi 25rb', 888001);

      await t.deliver(update).expect(503); // first attempt: not acknowledged, nothing stored
      expect(await rowsOf(A)).toHaveLength(0);

      await t.deliver(update).expect(200); // redelivered by Telegram
      expect((await rowsOf(A)).filter((r) => r.description === 'kopi')).toHaveLength(1);
      spy.mockRestore();
    });

    it('tells the user and stops retrying after the attempt limit', async () => {
      const spy = failing(3);
      const update = buildUpdate(A, 'beli kopi 25rb', 888002);

      await t.deliver(update).expect(503);
      await t.deliver(update).expect(503);
      await t.deliver(update).expect(200); // third failure: give up, acknowledge
      expect(t.telegram.last(String(A))).toContain('Maaf, ada gangguan');
      expect(await rowsOf(A)).toHaveLength(0); // and nothing half-saved
      spy.mockRestore();
    });

    it('survives Telegram being unreachable while replying (data is still saved once)', async () => {
      await say(A, 'halo');
      t.telegram.failSends = true;
      const update = buildUpdate(A, 'beli kopi 25rb', 888003);
      await t.deliver(update).expect(503); // reply could not be sent -> redelivery
      t.telegram.failSends = false;
      await t.deliver(update).expect(200);
      expect((await rowsOf(A)).filter((r) => r.description === 'kopi')).toHaveLength(1);
    });
  });

  describe('privacy of logs and audit events', () => {
    it('never records message text or amounts', async () => {
      const lines: string[] = [];
      const capture = (msg: unknown, ...rest: unknown[]) =>
        lines.push(JSON.stringify([msg, ...rest]));
      Logger.overrideLogger({
        log: capture,
        error: capture,
        warn: capture,
        debug: capture,
        verbose: capture,
      });

      const audit = t.app.get(AuditLogRepository);
      const spy = jest.spyOn(audit, 'record');
      try {
        await t.say(A, 'halo');
        await t.say(A, 'beli rahasia-kopi-xyz 77777rb').expect(200);
        const users = t.app.get(UserRepository);
        jest.spyOn(users, 'findOrCreate').mockRejectedValueOnce(new Error('boom rahasia-kopi-xyz'));
        await t.deliver(buildUpdate(A, 'beli rahasia-kopi-xyz 88888rb', 999001)).expect(503);
        jest.restoreAllMocks();
      } finally {
        Logger.overrideLogger(false);
      }

      const everything = JSON.stringify(spy.mock.calls) + lines.join('\n');
      expect(everything).not.toContain('rahasia-kopi-xyz');
      expect(everything).not.toContain('77777');
      expect(everything).not.toContain('88888');
      expect(spy.mock.calls.length).toBeGreaterThan(0); // we did observe audit events
    });
  });

  describe('abuse controls', () => {
    it('limits one user, warns once, and does not affect other users', async () => {
      const limited = await createTestApp({ USER_RATE_LIMIT_PER_MINUTE: '3' });
      try {
        for (let i = 0; i < 6; i++) await limited.say(A, 'halo').expect(200);
        const warnings = limited.telegram.texts.filter((m) => m.text.includes('Pelan-pelan'));
        expect(warnings).toHaveLength(1); // told once, not on every dropped message

        limited.telegram.clear();
        await limited.say(B, 'halo').expect(200);
        expect(limited.telegram.texts.length).toBeGreaterThan(0); // B is unaffected
      } finally {
        await limited.close();
      }
    });
  });

  describe('health', () => {
    it('is live and ready with a working database', async () => {
      await httpOf(t).get('/health/live').expect(200);
      const ready = await httpOf(t).get('/health/ready').expect(200);
      const body = ready.body as { status: string; checks: { database: { status: string } } };
      expect(body.status).toMatch(/ok|degraded/);
      expect(body.checks.database.status).toBe('up');
    });

    it('does not announce the framework in a response header', async () => {
      for (const path of ['/', '/health/live', '/no-such-route']) {
        const res = await httpOf(t).get(path);
        expect(res.headers['x-powered-by']).toBeUndefined();
      }
    });

    it('turns not-ready (503) when the database is unreachable, but stays live', async () => {
      const prisma = t.app.get(PrismaService);
      const ping = jest.spyOn(prisma, 'ping').mockRejectedValue(new Error('connection refused'));
      const http = httpOf(t);
      try {
        // readiness is cached for a few seconds, so build a fresh service state via a new app
        const fresh = await createTestApp();
        const freshPing = jest
          .spyOn(fresh.prisma, 'ping')
          .mockRejectedValue(new Error('connection refused'));
        const freshHttp = httpOf(fresh);
        try {
          const res = await freshHttp.get('/health/ready').expect(503);
          expect(JSON.stringify(res.body)).not.toContain('refused');
          // the 503 explains itself: which check is down and why, in a fixed sentence
          expect(res.body).toMatchObject({
            status: 'down',
            checks: { database: { status: 'down', detail: 'PostgreSQL is not reachable' } },
          });
          await freshHttp.get('/health/live').expect(200);
        } finally {
          freshPing.mockRestore();
          await fresh.close();
        }
      } finally {
        ping.mockRestore();
        void http;
      }
    });
  });
});
