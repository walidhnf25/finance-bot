/**
 * The database audit trail and the retention job, against real PostgreSQL:
 *  - which actions are stored, what a stored event may contain, and that a failing store never breaks the caller;
 *  - the trail survives a "reset my data";
 *  - retention removes only unconfirmed leftovers and old audit rows and never touches the financial record.
 */
import { PrismaService } from '../../src/database/prisma.service';
import { DbAuditLogRepository } from '../../src/modules/audit/infrastructure/db-audit-log.repository';
import { LoggerAuditLogRepository } from '../../src/modules/audit/infrastructure/logger-audit-log.repository';
import { MetricsService } from '../../src/modules/observability/metrics.service';
import { RetentionService } from '../../src/modules/retention/infrastructure/retention.service';
import { ResetUserDataService } from '../../src/modules/user/application/reset-user-data.service';
import { PrismaUserDataResetRepository } from '../../src/modules/user/infrastructure/prisma-user-data-reset.repository';
import { connectTestPrisma, createUser, resetDatabase } from '../setup/test-db';

const NOW = new Date('2026-07-15T05:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

describe('audit trail and retention (PostgreSQL)', () => {
  let prisma: PrismaService;
  let audit: DbAuditLogRepository;

  beforeAll(async () => {
    prisma = await connectTestPrisma();
  });
  afterAll(async () => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.auditEvent.deleteMany();
    audit = new DbAuditLogRepository(prisma, new LoggerAuditLogRepository());
  });

  describe('audit events', () => {
    it('stores financial and administrative actions with ids only', async () => {
      const u = await createUser(prisma);
      await audit.record({
        userId: u.id,
        action: 'TX_CREATE',
        metadata: { transactionId: 'tx-1', type: 'EXPENSE' },
      });
      const rows = await prisma.auditEvent.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: u.id, action: 'TX_CREATE' });
      expect(rows[0].metadata).toEqual({ transactionId: 'tx-1', type: 'EXPENSE' });
    });

    it('keeps per-message chatter out of the database (it stays in the log)', async () => {
      const u = await createUser(prisma);
      await audit.record({ userId: u.id, action: 'MESSAGE_IN', metadata: { length: 12 } });
      await audit.record({ userId: u.id, action: 'MESSAGE_OUT' });
      expect(await prisma.auditEvent.count()).toBe(0);
    });

    it('replaces oversized or unserialisable metadata with a marker instead of failing', async () => {
      await audit.record({ action: 'TX_EDIT', metadata: { blob: 'x'.repeat(5_000) } });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await audit.record({ action: 'TX_EDIT', metadata: circular });
      const metas = (await prisma.auditEvent.findMany({ orderBy: { createdAt: 'asc' } })).map(
        (r) => r.metadata,
      );
      expect(metas).toEqual([{ truncated: true }, { unserialisable: true }]);
    });

    it('a failing store never breaks the operation being audited', async () => {
      const broken = {
        auditEvent: { create: () => Promise.reject(new Error('relation does not exist')) },
      } as unknown as PrismaService;
      const repo = new DbAuditLogRepository(broken, new LoggerAuditLogRepository());
      await expect(repo.record({ userId: 'u', action: 'TX_CREATE' })).resolves.toBeUndefined();
    });

    it('the database itself refuses a long action name and an oversized metadata document', async () => {
      await expect(
        prisma.auditEvent.create({ data: { action: 'A'.repeat(65) } }),
      ).rejects.toThrow();
      await expect(
        prisma.auditEvent.create({
          data: { action: 'TX_CREATE', metadata: { blob: 'x'.repeat(6_000) } },
        }),
      ).rejects.toThrow();
      await expect(prisma.auditEvent.create({ data: { action: '' } })).rejects.toThrow();
    });

    it("lists a user's events newest first, bounded, and never another user's", async () => {
      const a = await createUser(prisma, 'a');
      const b = await createUser(prisma, 'b');
      for (let i = 0; i < 5; i += 1) {
        await prisma.auditEvent.create({
          data: { userId: a.id, action: 'TX_CREATE', createdAt: daysAgo(10 - i) },
        });
      }
      await prisma.auditEvent.create({ data: { userId: b.id, action: 'TX_DELETE' } });

      const events = await audit.findForUser(a.id, 3);
      expect(events).toHaveLength(3);
      expect(events.every((e) => e.userId === a.id)).toBe(true);
      expect(events[0].createdAt.getTime()).toBeGreaterThan(events[2].createdAt.getTime());
      expect(await audit.findForUser(a.id, 100_000)).toHaveLength(5); // the limit is clamped, not trusted
    });

    it('survives "reset my data" and records that the reset happened', async () => {
      const u = await createUser(prisma);
      await audit.record({ userId: u.id, action: 'TX_CREATE', metadata: { transactionId: 't' } });
      await new ResetUserDataService(new PrismaUserDataResetRepository(prisma), audit).reset(u.id);

      const actions = (await prisma.auditEvent.findMany({ orderBy: { createdAt: 'asc' } })).map(
        (e) => e.action,
      );
      expect(actions).toEqual(['TX_CREATE', 'USER_RESET']);
    });
  });

  describe('retention', () => {
    const policy = { intervalHours: 6, receiptDraftDays: 30, auditDays: 365 };
    let metrics: MetricsService;
    const service = (over: Partial<typeof policy> = {}) =>
      new RetentionService(prisma, { ...policy, ...over }, metrics);

    beforeEach(() => {
      metrics = new MetricsService();
    });
    afterEach(() => metrics.close());

    const draft = async (
      userId: string,
      status: 'PENDING' | 'CANCELLED' | 'EXPIRED' | 'CONFIRMED',
      opts: { expiresAt?: Date; ageDays?: number; transactionId?: string } = {},
    ) => {
      const row = await prisma.receiptDraft.create({
        data: {
          userId,
          status,
          imageSha256: `${status}-${Math.random()}`,
          extraction: { merchant: 'X', total: 1000 },
          expiresAt: opts.expiresAt ?? daysAgo(1),
          transactionId: opts.transactionId ?? null,
        },
      });
      if (opts.ageDays !== undefined) {
        await prisma.$executeRaw`UPDATE receipt_drafts SET updated_at = ${daysAgo(opts.ageDays)} WHERE id = ${row.id}`;
      }
      return row.id;
    };

    it('expires stale PENDING drafts, deletes old unconfirmed ones, and keeps everything else', async () => {
      const u = await createUser(prisma);
      const tx = await prisma.transaction.create({
        data: {
          userId: u.id,
          type: 'EXPENSE',
          amountMinor: 100_000n,
          description: 'kept',
          occurredAt: NOW,
        },
      });
      const stale = await draft(u.id, 'PENDING', { expiresAt: daysAgo(1) });
      const fresh = await draft(u.id, 'PENDING', { expiresAt: new Date(NOW.getTime() + 600_000) });
      const oldCancelled = await draft(u.id, 'CANCELLED', { ageDays: 45 });
      const recentCancelled = await draft(u.id, 'CANCELLED', { ageDays: 5 });
      const oldExpired = await draft(u.id, 'EXPIRED', { ageDays: 90 });
      const oldConfirmed = await draft(u.id, 'CONFIRMED', { ageDays: 400, transactionId: tx.id });

      const report = await service().runOnce(NOW);
      expect(report).toMatchObject({ expiredDrafts: 1, deletedDrafts: 2 });

      const left = new Map(
        (await prisma.receiptDraft.findMany()).map((d) => [d.id, d.status] as const),
      );
      expect(left.get(stale)).toBe('EXPIRED'); // marked, then kept for the retention window
      expect(left.get(fresh)).toBe('PENDING');
      expect(left.has(oldCancelled)).toBe(false);
      expect(left.get(recentCancelled)).toBe('CANCELLED');
      expect(left.has(oldExpired)).toBe(false);
      expect(left.get(oldConfirmed)).toBe('CONFIRMED'); // part of a transaction's history: never deleted
    });

    it('never touches the financial record', async () => {
      const u = await createUser(prisma);
      await prisma.transaction.create({
        data: {
          userId: u.id,
          type: 'INCOME',
          amountMinor: 5n,
          description: 'a',
          occurredAt: daysAgo(900),
        },
      });
      await prisma.transfer.create({
        data: {
          userId: u.id,
          fromWallet: 'CASH',
          toWallet: 'DIGITAL',
          amountMinor: 7n,
          occurredAt: daysAgo(900),
        },
      });
      await prisma.budget.create({
        data: { userId: u.id, scopeKey: 'ALL', amountMinor: 9n, period: 'MONTHLY' },
      });
      const before = {
        users: await prisma.user.count(),
        tx: await prisma.transaction.count(),
        tr: await prisma.transfer.count(),
        bu: await prisma.budget.count(),
        cat: await prisma.category.count(),
      };
      await draft(u.id, 'CANCELLED', { ageDays: 400 });

      await service({ receiptDraftDays: 1, auditDays: 1 }).runOnce(NOW);

      expect({
        users: await prisma.user.count(),
        tx: await prisma.transaction.count(),
        tr: await prisma.transfer.count(),
        bu: await prisma.budget.count(),
        cat: await prisma.category.count(),
      }).toEqual(before);
    });

    it('removes long-expired conversation state but not a live one', async () => {
      const a = await createUser(prisma, 'a');
      const b = await createUser(prisma, 'b');
      await prisma.conversation.create({ data: { userId: a.id, expiresAt: daysAgo(30) } });
      await prisma.conversation.create({ data: { userId: b.id, expiresAt: daysAgo(1) } });
      const report = await service().runOnce(NOW);
      expect(report.deletedConversations).toBe(1);
      expect((await prisma.conversation.findMany()).map((c) => c.userId)).toEqual([b.id]);
    });

    it('prunes audit events past their window and keeps newer ones', async () => {
      await prisma.auditEvent.create({ data: { action: 'TX_CREATE', createdAt: daysAgo(400) } });
      await prisma.auditEvent.create({ data: { action: 'TX_CREATE', createdAt: daysAgo(30) } });
      const report = await service().runOnce(NOW);
      expect(report.deletedAuditEvents).toBe(1);
      expect(await prisma.auditEvent.count()).toBe(1);
    });

    it('a window of 0 means "keep forever"', async () => {
      const u = await createUser(prisma);
      await draft(u.id, 'CANCELLED', { ageDays: 4_000 });
      await prisma.auditEvent.create({ data: { action: 'TX_CREATE', createdAt: daysAgo(4_000) } });
      const report = await service({ receiptDraftDays: 0, auditDays: 0 }).runOnce(NOW);
      expect(report.deletedDrafts).toBe(0);
      expect(report.deletedAuditEvents).toBe(0);
      expect(await prisma.receiptDraft.count()).toBe(1);
      expect(await prisma.auditEvent.count()).toBe(1);
    });

    it('is idempotent: a second run has nothing left to do', async () => {
      const u = await createUser(prisma);
      await draft(u.id, 'CANCELLED', { ageDays: 90 });
      await service().runOnce(NOW);
      expect(await service().runOnce(NOW)).toEqual({
        expiredDrafts: 0,
        deletedDrafts: 0,
        deletedConversations: 0,
        deletedAuditEvents: 0,
      });
    });

    it('two overlapping runs never double-process: the second returns at once with nothing done', async () => {
      const u = await createUser(prisma);
      await draft(u.id, 'CANCELLED', { ageDays: 90 });
      const svc = service();
      const [first, second] = await Promise.all([svc.runOnce(NOW), svc.runOnce(NOW)]);
      expect(first.deletedDrafts + second.deletedDrafts).toBe(1);
    });

    it('one failing step is logged and the others still run', async () => {
      const u = await createUser(prisma);
      await draft(u.id, 'CANCELLED', { ageDays: 90 });
      const failing = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === 'conversation') {
            return { deleteMany: () => Promise.reject(new Error('boom')) };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      const report = await new RetentionService(failing, policy, metrics).runOnce(NOW);
      expect(report.deletedConversations).toBe(0);
      expect(report.deletedDrafts).toBe(1);
    });

    it('counts what it removed in the metrics', async () => {
      const u = await createUser(prisma);
      await draft(u.id, 'CANCELLED', { ageDays: 90 });
      await service().runOnce(NOW);
      expect(metrics.render()).toContain('retention_deleted_total{kind="receipt_drafts"} 1');
    });
  });
});
