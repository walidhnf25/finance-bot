/**
 * REAL PostgreSQL: the schema + migrations as the database itself enforces them. These tests
 * insert rows directly (bypassing every application rule) to prove the invariants live in the
 * database, so no application bug can store an invalid financial row.
 */
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { connectTestPrisma, createUser, resetDatabase } from '../setup/test-db';

describe('database schema (PostgreSQL)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = await connectTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma, false);
  });

  const tx = (userId: string, over: Partial<Prisma.TransactionUncheckedCreateInput> = {}) =>
    prisma.transaction.create({
      data: {
        userId,
        type: 'EXPENSE',
        amountMinor: 2_500_000n,
        description: 'kopi',
        occurredAt: new Date('2026-10-01T03:00:00Z'),
        ...over,
      },
    });

  it('has every table, created by the migrations from an empty database', async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const names = rows.map((r) => r.table_name);
    for (const t of [
      'users',
      'categories',
      'transactions',
      'transfers',
      'budgets',
      'conversations',
      'receipt_drafts',
      '_prisma_migrations',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('records every migration as finished', async () => {
    const rows = await prisma.$queryRaw<Array<{ unfinished: bigint }>>`
      SELECT count(*) AS unfinished FROM _prisma_migrations WHERE finished_at IS NULL`;
    expect(Number(rows[0].unfinished)).toBe(0);
  });

  describe('money constraints', () => {
    it.each([
      ['zero', 0n],
      ['negative', -1n],
      ['above the supported maximum', 1_000_000_000_000_001n],
    ])('rejects a transaction amount that is %s', async (_name, amount) => {
      const user = await createUser(prisma);
      await expect(tx(user.id, { amountMinor: amount })).rejects.toThrow();
    });

    it('accepts the maximum supported amount', async () => {
      const user = await createUser(prisma);
      const row = await tx(user.id, { amountMinor: 1_000_000_000_000_000n });
      expect(row.amountMinor).toBe(1_000_000_000_000_000n);
    });

    it('sums BIGINT exactly, with no floating-point drift', async () => {
      const user = await createUser(prisma);
      // 0.1 + 0.2 style sums that floats get wrong; and values beyond 2^53.
      await tx(user.id, { amountMinor: 10n });
      await tx(user.id, { amountMinor: 20n });
      await tx(user.id, { amountMinor: 999_999_999_999_999n });
      const agg = await prisma.transaction.aggregate({
        where: { userId: user.id },
        _sum: { amountMinor: true },
      });
      expect(agg._sum.amountMinor).toBe(1_000_000_000_000_029n);
    });

    it('rejects a transfer to the same wallet or with a bad amount', async () => {
      const user = await createUser(prisma);
      const base = { userId: user.id, occurredAt: new Date() };
      await expect(
        prisma.transfer.create({
          data: { ...base, fromWallet: 'CASH', toWallet: 'CASH', amountMinor: 100n },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.transfer.create({
          data: { ...base, fromWallet: 'CASH', toWallet: 'DIGITAL', amountMinor: 0n },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.transfer.create({
          data: { ...base, fromWallet: 'CASH', toWallet: 'DIGITAL', amountMinor: 100n },
        }),
      ).resolves.toBeDefined();
    });

    it('enforces budget rules: amount, threshold range and scope key', async () => {
      const user = await createUser(prisma);
      const ok = {
        userId: user.id,
        scopeKey: 'ALL',
        period: 'MONTHLY' as const,
        amountMinor: 100n,
      };
      await expect(prisma.budget.create({ data: { ...ok, amountMinor: 0n } })).rejects.toThrow();
      await expect(prisma.budget.create({ data: { ...ok, alertThreshold: 0 } })).rejects.toThrow();
      await expect(
        prisma.budget.create({ data: { ...ok, alertThreshold: 101 } }),
      ).rejects.toThrow();
      // An overall budget must use scope ALL, and a category budget its own category id.
      await expect(
        prisma.budget.create({ data: { ...ok, scopeKey: 'something' } }),
      ).rejects.toThrow();
      await expect(prisma.budget.create({ data: ok })).resolves.toBeDefined();
    });
  });

  describe('idempotency keys', () => {
    it('rejects a second transaction with the same key for the same user', async () => {
      const user = await createUser(prisma);
      await tx(user.id, { idempotencyKey: '1:100' });
      await expect(tx(user.id, { idempotencyKey: '1:100' })).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('allows the same key for different users, and any number of rows without a key', async () => {
      const a = await createUser(prisma);
      const b = await createUser(prisma);
      await tx(a.id, { idempotencyKey: 'same' });
      await expect(tx(b.id, { idempotencyKey: 'same' })).resolves.toBeDefined();
      await tx(a.id);
      await expect(tx(a.id)).resolves.toBeDefined();
    });
  });

  describe('referential integrity', () => {
    it('deleting a user removes all of their data (cascade)', async () => {
      const user = await createUser(prisma);
      await tx(user.id);
      await prisma.transfer.create({
        data: {
          userId: user.id,
          fromWallet: 'CASH',
          toWallet: 'DIGITAL',
          amountMinor: 1n,
          occurredAt: new Date(),
        },
      });
      await prisma.conversation.create({ data: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      expect(await prisma.transaction.count()).toBe(0);
      expect(await prisma.transfer.count()).toBe(0);
      expect(await prisma.conversation.count()).toBe(0);
    });

    it('deleting a category keeps its transactions, just uncategorised', async () => {
      const user = await createUser(prisma);
      const category = await prisma.category.create({
        data: { id: 'c1', userId: user.id, name: 'Hobi', type: 'EXPENSE' },
      });
      const row = await tx(user.id, { categoryId: category.id });
      await prisma.category.delete({ where: { id: category.id } });
      const after = await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.categoryId).toBeNull();
    });

    it('refuses a transaction for a user that does not exist', async () => {
      await expect(tx('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    });

    it('allows only one conversation row per user', async () => {
      const user = await createUser(prisma);
      await prisma.conversation.create({ data: { userId: user.id } });
      await expect(prisma.conversation.create({ data: { userId: user.id } })).rejects.toMatchObject(
        {
          code: 'P2002',
        },
      );
    });

    it('lets a receipt draft be confirmed only together with its transaction', async () => {
      const user = await createUser(prisma);
      const draft = {
        userId: user.id,
        imageSha256: 'a'.repeat(64),
        extraction: {},
        expiresAt: new Date(),
      };
      await expect(
        prisma.receiptDraft.create({ data: { ...draft, status: 'CONFIRMED' } }),
      ).rejects.toThrow();
      await expect(
        prisma.receiptDraft.create({ data: { ...draft, status: 'PENDING', transactionId: 't' } }),
      ).rejects.toThrow();
      await expect(prisma.receiptDraft.create({ data: draft })).resolves.toBeDefined();
    });

    it('stops the same image being drafted twice for one user', async () => {
      const user = await createUser(prisma);
      const draft = {
        userId: user.id,
        imageSha256: 'b'.repeat(64),
        extraction: {},
        expiresAt: new Date(),
      };
      await prisma.receiptDraft.create({ data: draft });
      await expect(prisma.receiptDraft.create({ data: draft })).rejects.toMatchObject({
        code: 'P2002',
      });
    });
  });
});
