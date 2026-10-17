/**
 * REAL PostgreSQL: PrismaTransactionRepository. Covers the properties only a real database gives:
 * database-enforced idempotency, atomic batches, per-user isolation and exact aggregation,
 * including under concurrent requests.
 */
import { PrismaService } from '../../src/database/prisma.service';
import { CreateTransactionInput } from '../../src/modules/transaction/domain/transaction.entity';
import { PrismaTransactionRepository } from '../../src/modules/transaction/infrastructure/prisma-transaction.repository';
import { TransactionType, Wallet } from '../../src/shared/domain/enums';
import { Money } from '../../src/shared/utils/money';
import { connectTestPrisma, createUser, resetDatabase } from '../setup/test-db';

const RANGE = {
  start: new Date('2026-10-01T00:00:00Z'),
  end: new Date('2026-10-31T23:59:59Z'),
};

describe('PrismaTransactionRepository (PostgreSQL)', () => {
  let prisma: PrismaService;
  let repo: PrismaTransactionRepository;

  beforeAll(async () => {
    prisma = await connectTestPrisma();
    repo = new PrismaTransactionRepository(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  const input = (
    userId: string,
    over: Partial<CreateTransactionInput> = {},
  ): CreateTransactionInput => ({
    userId,
    type: TransactionType.EXPENSE,
    amount: Money.fromMajor(25000),
    description: 'kopi',
    occurredAt: new Date('2026-10-10T03:00:00Z'),
    ...over,
  });
  const count = (userId?: string) =>
    prisma.transaction.count({ where: userId ? { userId } : undefined });

  describe('idempotency', () => {
    it('returns null instead of inserting a second row for the same message id', async () => {
      const u = await createUser(prisma);
      const first = await repo.create(input(u.id, { messageId: '1:100' }));
      const second = await repo.create(input(u.id, { messageId: '1:100' }));

      expect(first?.amount.toNumber()).toBe(25000);
      expect(second).toBeNull();
      expect(await count(u.id)).toBe(1);
    });

    it('stays correct when 25 identical requests race each other', async () => {
      const u = await createUser(prisma);
      const results = await Promise.all(
        Array.from({ length: 25 }, () => repo.create(input(u.id, { messageId: '1:race' }))),
      );

      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(await count(u.id)).toBe(1);
    });

    it('treats a soft-deleted transaction as already recorded', async () => {
      const u = await createUser(prisma);
      const row = await repo.create(input(u.id, { messageId: '1:200' }));
      await repo.softDelete(u.id, row!.id);

      expect(await repo.existsByMessageId(u.id, '1:200')).toBe(true);
      expect(await repo.create(input(u.id, { messageId: '1:200' }))).toBeNull();
    });

    it('lets two users use the same message id', async () => {
      const a = await createUser(prisma);
      const b = await createUser(prisma);
      expect(await repo.create(input(a.id, { messageId: 'same' }))).not.toBeNull();
      expect(await repo.create(input(b.id, { messageId: 'same' }))).not.toBeNull();
      expect(await repo.existsByMessageId(a.id, 'nope')).toBe(false);
    });
  });

  describe('createMany (one message, several items)', () => {
    const batch = (userId: string, n: number, key = '9:1'): CreateTransactionInput[] =>
      Array.from({ length: n }, (_, i) =>
        input(userId, {
          messageId: `${key}#${i}`,
          description: `item${i}`,
          amount: Money.fromMajor(1000 * (i + 1)),
        }),
      );

    it('stores every item and returns them in order', async () => {
      const u = await createUser(prisma);
      const rows = await repo.createMany(batch(u.id, 3));
      expect(rows.map((r) => r?.description)).toEqual(['item0', 'item1', 'item2']);
      expect(await count(u.id)).toBe(3);
    });

    it('is all-or-nothing: one invalid item rolls the whole batch back', async () => {
      const u = await createUser(prisma);
      const items = batch(u.id, 3);
      items[2] = { ...items[2], amount: Money.zero() }; // violates the database CHECK

      await expect(repo.createMany(items)).rejects.toThrow();
      expect(await count(u.id)).toBe(0); // items 0 and 1 were NOT left behind
    });

    it('does nothing the second time the same message is processed', async () => {
      const u = await createUser(prisma);
      await repo.createMany(batch(u.id, 3));
      const again = await repo.createMany(batch(u.id, 3));

      expect(again).toEqual([null, null, null]);
      expect(await count(u.id)).toBe(3);
    });

    it('adds only the missing items when part of the batch already exists', async () => {
      const u = await createUser(prisma);
      await repo.create(input(u.id, { messageId: '9:1#1', description: 'item1' }));

      const rows = await repo.createMany(batch(u.id, 3));
      expect(rows.map((r) => r !== null)).toEqual([true, false, true]);
      expect(await count(u.id)).toBe(3);
    });

    it('never duplicates when the same batch is submitted concurrently', async () => {
      const u = await createUser(prisma);
      await Promise.all(Array.from({ length: 6 }, () => repo.createMany(batch(u.id, 4))));
      expect(await count(u.id)).toBe(4);
    });

    it('keeps "latest transaction" well defined inside a batch', async () => {
      const u = await createUser(prisma);
      await repo.createMany(batch(u.id, 4));
      expect((await repo.findLatestForUser(u.id))?.description).toBe('item3');
    });
  });

  describe('ownership: an id never grants access', () => {
    it("cannot read, edit or delete another user's transaction", async () => {
      const owner = await createUser(prisma);
      const intruder = await createUser(prisma);
      const row = (await repo.create(input(owner.id)))!;

      expect(await repo.findById(intruder.id, row.id)).toBeNull();
      await expect(
        repo.update(intruder.id, row.id, { amount: Money.fromMajor(1) }),
      ).rejects.toThrow('not found');
      await expect(repo.softDelete(intruder.id, row.id)).rejects.toThrow('not found');

      const untouched = await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } });
      expect(untouched.amountMinor).toBe(2_500_000n);
      expect(untouched.deletedAt).toBeNull();
      expect((await repo.findById(owner.id, row.id))?.id).toBe(row.id);
    });

    it('lets the owner edit and delete', async () => {
      const u = await createUser(prisma);
      const row = (await repo.create(input(u.id)))!;
      const updated = await repo.update(u.id, row.id, {
        amount: Money.fromMajor(30000),
        wallet: Wallet.DIGITAL,
      });
      expect(updated.amount.toNumber()).toBe(30000);
      expect(updated.wallet).toBe(Wallet.DIGITAL);

      await repo.softDelete(u.id, row.id);
      expect(await repo.findById(u.id, row.id)).toBeNull();
      await expect(repo.softDelete(u.id, row.id)).rejects.toThrow('not found'); // already deleted
    });

    it("never mixes users' data in lists or totals", async () => {
      const a = await createUser(prisma);
      const b = await createUser(prisma);
      await repo.create(input(a.id, { amount: Money.fromMajor(1000) }));
      await repo.create(input(b.id, { amount: Money.fromMajor(999999) }));

      expect((await repo.findManyInRange(a.id, RANGE)).map((r) => r.amount.toNumber())).toEqual([
        1000,
      ]);
      expect((await repo.sumByType(a.id, RANGE)).expense.toNumber()).toBe(1000);
      expect((await repo.sumByWallet(a.id))[Wallet.CASH].expense.toNumber()).toBe(1000);
      expect((await repo.findLatestForUser(a.id))?.amount.toNumber()).toBe(1000);
    });
  });

  describe('exact aggregation', () => {
    it('sums income and expense in the database without rounding errors', async () => {
      const u = await createUser(prisma);
      for (const amount of ['0.10', '0.20', '1000000000000.05']) {
        await repo.create(input(u.id, { amount: Money.fromMajor(amount) }));
      }
      await repo.create(
        input(u.id, { type: TransactionType.INCOME, amount: Money.fromMajor('5000000') }),
      );

      const totals = await repo.sumByType(u.id, RANGE);
      expect(totals.expense.toDecimalString()).toBe('1000000000000.35'); // floats would drift here
      expect(totals.income.toDecimalString()).toBe('5000000.00');
    });

    it('excludes deleted rows and respects the inclusive date range', async () => {
      const u = await createUser(prisma);
      await repo.create(input(u.id, { amount: Money.fromMajor(100), occurredAt: RANGE.start }));
      await repo.create(input(u.id, { amount: Money.fromMajor(200), occurredAt: RANGE.end }));
      await repo.create(
        input(u.id, { amount: Money.fromMajor(400), occurredAt: new Date('2026-09-30T23:59:59Z') }),
      );
      const gone = (await repo.create(input(u.id, { amount: Money.fromMajor(800) })))!;
      await repo.softDelete(u.id, gone.id);

      expect((await repo.sumByType(u.id, RANGE)).expense.toNumber()).toBe(300);
    });

    it('counts a transaction without a wallet as CASH', async () => {
      const u = await createUser(prisma);
      await repo.create(input(u.id, { amount: Money.fromMajor(100) })); // no wallet
      await repo.create(input(u.id, { amount: Money.fromMajor(10), wallet: Wallet.CASH }));
      await repo.create(input(u.id, { amount: Money.fromMajor(1), wallet: Wallet.DIGITAL }));

      const w = await repo.sumByWallet(u.id);
      expect(w[Wallet.CASH].expense.toNumber()).toBe(110);
      expect(w[Wallet.DIGITAL].expense.toNumber()).toBe(1);
      expect(await repo.hasExplicitWallet(u.id)).toBe(true);
      expect(await repo.hasTransactionsInWallet(u.id, Wallet.CASH)).toBe(true);
    });

    it('groups by category, optionally for one wallet, largest first', async () => {
      const u = await createUser(prisma);
      const food = await prisma.category.findFirstOrThrow({ where: { name: 'Makanan' } });
      const fuel = await prisma.category.findFirstOrThrow({ where: { name: 'Transportasi' } });
      await repo.create(input(u.id, { categoryId: food.id, amount: Money.fromMajor(50) }));
      await repo.create(
        input(u.id, { categoryId: fuel.id, amount: Money.fromMajor(70), wallet: Wallet.DIGITAL }),
      );
      await repo.create(
        input(u.id, { categoryId: food.id, amount: Money.fromMajor(5), wallet: Wallet.CASH }),
      );

      const all = await repo.sumByCategory(u.id, RANGE, TransactionType.EXPENSE);
      expect(all.map((c) => [c.categoryId, c.total.toNumber()])).toEqual([
        [fuel.id, 70],
        [food.id, 55],
      ]);
      const cash = await repo.sumByCategory(u.id, RANGE, TransactionType.EXPENSE, Wallet.CASH);
      expect(cash.map((c) => [c.categoryId, c.total.toNumber()])).toEqual([[food.id, 55]]);
    });

    it('stays exact when many requests insert at once', async () => {
      const u = await createUser(prisma);
      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          repo.create(input(u.id, { messageId: `c:${i}`, amount: Money.fromMajor(1250) })),
        ),
      );
      expect((await repo.sumByType(u.id, RANGE)).expense.toNumber()).toBe(50000);
    });
  });

  describe('replaceMarked (opening balance entries)', () => {
    const opening = (userId: string, amount: number, over: Partial<CreateTransactionInput> = {}) =>
      input(userId, {
        type: TransactionType.INCOME,
        amount: Money.fromMajor(amount),
        description: 'Saldo awal',
        note: 'SALDO_AWAL',
        wallet: Wallet.CASH,
        ...over,
      });

    it('replaces the previous entry of that wallet in one step', async () => {
      const u = await createUser(prisma);
      await repo.replaceMarked(
        u.id,
        Wallet.CASH,
        'SALDO_AWAL',
        opening(u.id, 100, { messageId: 'm1' }),
      );
      await repo.replaceMarked(
        u.id,
        Wallet.CASH,
        'SALDO_AWAL',
        opening(u.id, 250, { messageId: 'm2' }),
      );

      const live = await repo.findByNote(u.id, 'SALDO_AWAL');
      expect(live.map((r) => r.amount.toNumber())).toEqual([250]);
      expect(await count(u.id)).toBe(2); // the old one is soft-deleted, not lost
    });

    it('leaves the other wallet alone, and a zero replacement just removes', async () => {
      const u = await createUser(prisma);
      await repo.replaceMarked(u.id, Wallet.CASH, 'SALDO_AWAL', opening(u.id, 100));
      await repo.replaceMarked(
        u.id,
        Wallet.DIGITAL,
        'SALDO_AWAL',
        opening(u.id, 900, { wallet: Wallet.DIGITAL }),
      );
      await repo.replaceMarked(u.id, Wallet.CASH, 'SALDO_AWAL', null);

      const live = await repo.findByNote(u.id, 'SALDO_AWAL');
      expect(live.map((r) => [r.wallet, r.amount.toNumber()])).toEqual([[Wallet.DIGITAL, 900]]);
    });

    it('is atomic: a failing replacement keeps the old entry', async () => {
      const u = await createUser(prisma);
      await repo.replaceMarked(u.id, Wallet.CASH, 'SALDO_AWAL', opening(u.id, 100));

      await expect(
        repo.replaceMarked(u.id, Wallet.CASH, 'SALDO_AWAL', opening(u.id, 0)), // violates CHECK
      ).rejects.toThrow();

      expect((await repo.findByNote(u.id, 'SALDO_AWAL')).map((r) => r.amount.toNumber())).toEqual([
        100,
      ]);
    });

    it('applies the same message only once', async () => {
      const u = await createUser(prisma);
      await repo.replaceMarked(
        u.id,
        Wallet.CASH,
        'SALDO_AWAL',
        opening(u.id, 100, { messageId: 'k' }),
      );
      await repo.replaceMarked(
        u.id,
        Wallet.CASH,
        'SALDO_AWAL',
        opening(u.id, 100, { messageId: 'k' }),
      );
      await repo.replaceMarked(
        u.id,
        Wallet.CASH,
        'SALDO_AWAL',
        opening(u.id, 100, { messageId: 'k' }),
      );

      expect((await repo.findByNote(u.id, 'SALDO_AWAL')).map((r) => r.amount.toNumber())).toEqual([
        100,
      ]);
      expect(await count(u.id)).toBe(1);
    });

    it('treats an entry with no wallet as CASH', async () => {
      const u = await createUser(prisma);
      await repo.create(opening(u.id, 40, { wallet: undefined }));
      await repo.replaceMarked(u.id, Wallet.CASH, 'SALDO_AWAL', opening(u.id, 60));
      expect((await repo.findByNote(u.id, 'SALDO_AWAL')).map((r) => r.amount.toNumber())).toEqual([
        60,
      ]);
    });
  });
});
