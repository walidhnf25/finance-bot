/**
 * Observability through the real application: what /metrics reports, what it must never reveal, how
 * the health endpoints treat optional capabilities, and the input-length guard that protects the
 * pipeline before any parsing or database work.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { buildUpdate, createTestApp, TestApp } from '../setup/test-app';
import { connectTestPrisma, resetDatabase } from '../setup/test-db';
import { PrismaService } from '../../src/database/prisma.service';

const http = (t: TestApp) => request(t.app.getHttpServer() as Server);
const scrape = async (t: TestApp): Promise<string> =>
  (await http(t).get('/metrics').set('Host', '127.0.0.1:3100').expect(200)).text;
const value = (text: string, series: string): number => {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line ? Number(line.split(' ')[1]) : 0;
};

describe('observability (end to end)', () => {
  let observer: PrismaService;
  beforeAll(async () => {
    observer = await connectTestPrisma();
  });
  afterAll(async () => observer.$disconnect());
  beforeEach(async () => resetDatabase(observer));

  describe('/metrics', () => {
    it('counts processed, duplicate and unauthorized messages exactly', async () => {
      const t = await createTestApp({
        TELEGRAM_ALLOW_PUBLIC: 'false',
        TELEGRAM_ALLOWED_USER_IDS: '9001',
      });
      try {
        await t.deliver(buildUpdate(9001, 'beli kopi 25rb', 5001)).expect(200);
        await t.deliver(buildUpdate(9001, 'beli kopi 25rb', 5001)).expect(200); // same update again
        await t.deliver(buildUpdate(9001, 'beli teh 10rb', 5002)).expect(200);
        await t.deliver(buildUpdate(9002, 'beli roti 5rb', 5003)).expect(200); // not on the allowlist

        const text = await scrape(t);
        expect(value(text, 'updates_total{outcome="processed"}')).toBe(2);
        expect(value(text, 'updates_total{outcome="duplicate"}')).toBe(1);
        expect(value(text, 'updates_unauthorized_total')).toBe(1);
        expect(value(text, 'message_latency_ms_count')).toBe(3);
        expect(text).toContain('# TYPE updates_total counter');
        // and the unauthorized sender left no trace in the database
        expect(await t.prisma.user.count()).toBe(1);
      } finally {
        await t.close();
      }
    });

    it('never exposes user ids, message text, amounts or secrets', async () => {
      const t = await createTestApp();
      try {
        await t
          .deliver(buildUpdate(8123456, 'beli rahasia-sekali-12345 98765rb', 5101))
          .expect(200);
        const text = await scrape(t);
        for (const forbidden of [
          '8123456',
          'rahasia-sekali',
          '98765',
          'TEST-TOKEN',
          'postgres',
          t.secret,
        ]) {
          expect(text).not.toContain(forbidden);
        }
        // every labelled series uses only declared label values
        for (const line of text.split('\n').filter((l) => /^[a-z_]+\{/.test(l))) {
          expect(line).toMatch(/^[a-z_]+\{(?:[a-z_]+="[A-Za-z_0-9+.]+",?)+\} \d/);
        }
      } finally {
        await t.close();
      }
    });

    it('refuses a foreign Host header (DNS rebinding) and still serves loopback names', async () => {
      const t = await createTestApp();
      try {
        await http(t).get('/metrics').set('Host', 'evil.example.com').expect(403);
        await http(t).get('/metrics').set('Host', '192.168.1.20:3100').expect(403);
        await http(t).get('/metrics').set('Host', 'localhost:3100').expect(200);
        await http(t).get('/metrics').set('Host', '[::1]:3100').expect(200);
      } finally {
        await t.close();
      }
    });

    it('reports process gauges and the database ping after a readiness check', async () => {
      const t = await createTestApp();
      try {
        await http(t).get('/health/ready').expect(200);
        const text = await scrape(t);
        expect(value(text, 'uptime_seconds')).toBeGreaterThanOrEqual(0);
        expect(value(text, 'process_resident_memory_bytes')).toBeGreaterThan(0);
        expect(value(text, 'db_ping_ms_count')).toBeGreaterThanOrEqual(1);
      } finally {
        await t.close();
      }
    });
  });

  describe('health', () => {
    it('reports OCR as an optional capability: it can degrade the report but never take the app down', async () => {
      const t = await createTestApp();
      try {
        const ready = await http(t).get('/health/ready').expect(200);
        const body = ready.body as {
          status: string;
          checks: Record<string, { status: string; detail?: string }>;
        };
        expect(['up', 'degraded']).toContain(body.checks.ocr.status);
        expect(body.checks.database.status).toBe('up');
        expect(['ok', 'degraded']).toContain(body.status);
        // fixed strings only: no paths, URLs or credentials
        expect(JSON.stringify(body)).not.toMatch(/postgres(ql)?:\/\/|[A-Za-z]:\\/);
      } finally {
        await t.close();
      }
    });
  });

  describe('input-length guard', () => {
    it('refuses an oversized message before parsing or any database write', async () => {
      const t = await createTestApp({ MAX_INPUT_CHARS: '100' });
      try {
        const long = `beli kopi 25rb ${'x'.repeat(300)}`;
        await t.deliver(buildUpdate(9301, long, 5201)).expect(200);
        expect(t.telegram.last()).toMatch(/terlalu panjang/i);
        expect(await t.prisma.transaction.count()).toBe(0);
        expect(await t.prisma.user.count()).toBe(0); // not even the user row was created
        expect(value(await scrape(t), 'updates_total{outcome="too_long"}')).toBe(1);

        // a message of normal length is still handled
        await t.deliver(buildUpdate(9301, 'beli kopi 25rb', 5202)).expect(200);
        expect(await t.prisma.transaction.count()).toBe(1);
      } finally {
        await t.close();
      }
    });

    it('rejects a nonsensical limit at startup', async () => {
      await expect(createTestApp({ MAX_INPUT_CHARS: '5' })).rejects.toThrow(/MAX_INPUT_CHARS/);
      await expect(createTestApp({ MAX_INPUT_CHARS: '99999' })).rejects.toThrow(/MAX_INPUT_CHARS/);
    });
  });
});
