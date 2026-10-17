/**
 * Cross-user isolation probes. Two users exist, A (the victim) with data in EVERY user-owned table, and B
 * (the attacker). B calls every repository method that takes an id, a key or a marker, using A's values.
 * For each probe two things must hold:
 *   1. the answer reveals nothing about A (null / false / empty / a rejection), and
 *   2. A's data is byte-for-byte what it was (checked once at the end through a full snapshot).
 *
 * The static check (src/user-scoping.spec.ts) proves every query names an owner; these probes prove the
 * owner filter actually does its job against a real database.
 */
import { PrismaService } from '../../src/database/prisma.service';
import { PrismaBudgetRepository } from '../../src/modules/budget/infrastructure/prisma-budget.repository';
import { PrismaCategoryRepository } from '../../src/modules/category/infrastructure/prisma-category.repository';
import { PrismaConversationRepository } from '../../src/modules/conversation/infrastructure/prisma-conversation.repository';
import { validateExtraction } from '../../src/modules/receipt/domain/receipt-extraction';
import { PrismaReceiptRepository } from '../../src/modules/receipt/infrastructure/prisma-receipt.repository';
import { PrismaTransactionRepository } from '../../src/modules/transaction/infrastructure/prisma-transaction.repository';
import { ResetUserDataService } from '../../src/modules/user/application/reset-user-data.service';
import { PrismaUserDataResetRepository } from '../../src/modules/user/infrastructure/prisma-user-data-reset.repository';
import { PrismaTransferRepository } from '../../src/modules/wallet/infrastructure/prisma-transfer.repository';
import {
  BudgetPeriod,
  ConversationState,
  TransactionType,
  Wallet,
} from '../../src/shared/domain/enums';
import { Money } from '../../src/shared/utils/money';
import { connectTestPrisma, createUser, resetDatabase } from '../setup/test-db';

const NOW = new Date('2026-07-15T05:00:00.000Z');
const RANGE = { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-07-31T23:59:59Z') };
const extraction = () =>
  validateExtraction(
    { merchant: 'Toko A', date: '2026-07-15', total: 99_000, items: [], categoryHint: null },
    { now: NOW, timezone: 'Asia/Jakarta', sourceText: '' },
  );

describe('cross-user isolation probes (PostgreSQL)', () => {
  let prisma: PrismaService;
  let tx: PrismaTransactionRepository;
  let transfers: PrismaTransferRepository;
  let budgets: PrismaBudgetRepository;
  let categories: PrismaCategoryRepository;
  let conversations: PrismaConversationRepository;
  let receipts: PrismaReceiptRepository;

  let a: string; // victim
  let b: string; // attacker
  let aTxId: string;
  let aTransferId: string;
  let aBudgetId: string;
  let aCategoryId: string;
  let aDraftId: string;
  const A_KEY = '111:1';
  const A_NOTE = 'saldo-awal:CASH';
  const A_SHA = 'a'.repeat(64);

  beforeAll(async () => {
    prisma = await connectTestPrisma();
    tx = new PrismaTransactionRepository(prisma);
    transfers = new PrismaTransferRepository(prisma);
    budgets = new PrismaBudgetRepository(prisma);
    categories = new PrismaCategoryRepository(prisma);
    conversations = new PrismaConversationRepository(prisma);
    receipts = new PrismaReceiptRepository(prisma);
  });
  afterAll(async () => prisma.$disconnect());

  /** Everything A owns, in a stable order: any change to A's data changes this string. */
  const snapshotOfA = async (): Promise<string> => {
    const where = { userId: a };
    const [t, tr, bu, ca, dr, co] = await Promise.all([
      prisma.transaction.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.transfer.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.budget.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.category.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.receiptDraft.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.conversation.findMany({ where }),
    ]);
    return JSON.stringify({ t, tr, bu, ca, dr, co }, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
  };
  let before: string;

  beforeAll(async () => {
    await resetDatabase(prisma);
    a = (await createUser(prisma, 'victim')).id;
    b = (await createUser(prisma, 'attacker')).id;

    const category = await categories.create({
      userId: a,
      name: 'Rahasia A',
      type: TransactionType.EXPENSE,
    });
    aCategoryId = category.id;
    const created = await tx.create({
      userId: a,
      categoryId: aCategoryId,
      type: TransactionType.EXPENSE,
      amount: Money.fromMajor(25_000),
      description: 'kopi rahasia',
      note: A_NOTE,
      occurredAt: NOW,
      messageId: A_KEY,
      wallet: Wallet.CASH,
    });
    aTxId = created!.id;
    aTransferId = (await transfers.create({
      userId: a,
      from: Wallet.CASH,
      to: Wallet.DIGITAL,
      amount: Money.fromMajor(50_000),
      occurredAt: NOW,
      messageId: '111:2',
    }))!.id;
    aBudgetId = (
      await budgets.upsert({
        userId: a,
        categoryId: null,
        amount: Money.fromMajor(1_000_000),
        period: BudgetPeriod.MONTHLY,
      })
    ).id;
    await conversations.set({
      userId: a,
      state: ConversationState.AWAITING_AMOUNT,
      payload: { note: 'milik A' } as never,
      expiresAt: new Date(NOW.getTime() + 600_000),
    });
    const draft = await receipts.createDraft({
      userId: a,
      imageSha256: A_SHA,
      extraction: extraction(),
      expiresAt: new Date(NOW.getTime() + 1_800_000),
      now: NOW,
    });
    if (draft.kind !== 'created') throw new Error('draft expected');
    aDraftId = draft.draft.id;

    before = await snapshotOfA();
  });

  describe('transactions', () => {
    it("B cannot read A's transaction by id", async () => {
      expect(await tx.findById(b, aTxId)).toBeNull();
    });
    it("B cannot edit A's transaction", async () => {
      await expect(
        tx.update(b, aTxId, { amount: Money.fromMajor(1), description: 'dibajak' }),
      ).rejects.toThrow();
    });
    it("B cannot delete A's transaction", async () => {
      await expect(tx.softDelete(b, aTxId)).rejects.toThrow();
    });
    it("B's lists, totals and markers never include A's rows", async () => {
      expect(await tx.findLatestForUser(b)).toBeNull();
      expect(await tx.findManyInRange(b, RANGE)).toEqual([]);
      expect(await tx.findByNote(b, A_NOTE)).toEqual([]);
      const totals = await tx.sumByType(b, RANGE);
      expect(totals.income.minorUnits).toBe(0n);
      expect(totals.expense.minorUnits).toBe(0n);
      const perWallet = await tx.sumByWallet(b);
      expect(perWallet[Wallet.CASH].expense.minorUnits).toBe(0n);
      expect(await tx.sumByCategory(b, RANGE, TransactionType.EXPENSE)).toEqual([]);
      expect(await tx.hasTransactionsInWallet(b, Wallet.CASH)).toBe(false);
      expect(await tx.hasExplicitWallet(b)).toBe(false);
    });
    it('B cannot learn whether A used an idempotency key, and may reuse the same key itself', async () => {
      expect(await tx.existsByMessageId(b, A_KEY)).toBe(false);
      const own = await tx.create({
        userId: b,
        type: TransactionType.EXPENSE,
        amount: Money.fromMajor(7_000),
        description: 'milik B',
        occurredAt: NOW,
        messageId: A_KEY, // same key as A: unique per user, not global
      });
      expect(own).not.toBeNull();
      expect(own!.userId).toBe(b);
    });
    it("B replacing a wallet marker only ever touches B's own rows", async () => {
      await tx.replaceMarked(b, Wallet.CASH, A_NOTE, null);
      expect((await tx.findById(a, aTxId))?.deletedAt).toBeNull();
    });
  });

  describe('transfers', () => {
    it("B cannot delete A's transfer or see it", async () => {
      await expect(transfers.softDelete(b, aTransferId)).rejects.toThrow();
      expect(await transfers.findLatestForUser(b)).toBeNull();
      expect(await transfers.findManyInRange(b, RANGE)).toEqual([]);
      expect(await transfers.hasAny(b)).toBe(false);
      expect(await transfers.existsByMessageId(b, '111:2')).toBe(false);
      const sums = await transfers.sumByWallet(b);
      expect(sums[Wallet.CASH].out.minorUnits).toBe(0n);
      expect(sums[Wallet.DIGITAL].in.minorUnits).toBe(0n);
    });
  });

  describe('budgets', () => {
    it("B sees none of A's budgets and cannot delete them", async () => {
      expect(await budgets.findForUser(b)).toEqual([]);
      expect(await budgets.findByCategoryPeriod(b, null, BudgetPeriod.MONTHLY)).toBeNull();
      await budgets.delete(b, aBudgetId); // a documented no-op
      expect((await budgets.findForUser(a)).map((x) => x.id)).toEqual([aBudgetId]);
    });
    it("B's own budget for the same scope and period is a separate row, not A's overwritten", async () => {
      const mine = await budgets.upsert({
        userId: b,
        categoryId: null,
        amount: Money.fromMajor(5),
        period: BudgetPeriod.MONTHLY,
      });
      expect(mine.id).not.toBe(aBudgetId);
      expect((await budgets.findForUser(a))[0].amount.minorUnits).toBe(
        Money.fromMajor(1_000_000).minorUnits,
      );
    });
  });

  describe('categories', () => {
    it("A's custom category is invisible to B (by id, by listing, by name and by keyword)", async () => {
      expect(await categories.findById(aCategoryId, b)).toBeNull();
      expect((await categories.findAllForUser(b)).some((c) => c.id === aCategoryId)).toBe(false);
      expect(
        await categories.findByNameAndType('Rahasia A', TransactionType.EXPENSE, b),
      ).toBeNull();
      expect(
        await categories.findByKeyword('Rahasia A', { type: TransactionType.EXPENSE, userId: b }),
      ).toBeNull();
    });
    it('A still sees its own, and everyone sees the system categories', async () => {
      expect((await categories.findById(aCategoryId, a))?.name).toBe('Rahasia A');
      const system = (await categories.findSystem())[0];
      expect((await categories.findById(system.id, b))?.id).toBe(system.id);
    });
  });

  describe('conversation state', () => {
    it("B never reads or clears A's dialog", async () => {
      expect(await conversations.getActive(b, NOW)).toBeNull();
      await conversations.clear(b);
      expect((await conversations.getActive(a, NOW))?.state).toBe(
        ConversationState.AWAITING_AMOUNT,
      );
    });
  });

  describe('receipt drafts', () => {
    it("B cannot see, edit, cancel or confirm A's draft - and confirming creates nothing", async () => {
      expect(await receipts.findPending(b, NOW)).toBeNull();
      expect(await receipts.findPendingByImage(b, A_SHA, NOW)).toBeNull();
      expect(
        await receipts.updateExtraction(b, aDraftId, extraction(), new Date(NOW.getTime() + 1e6)),
      ).toBe(false);
      expect(await receipts.cancel(b, aDraftId)).toBe(false);
      expect(await receipts.countSince(b, new Date(0))).toBe(0);

      const attempt = await receipts.confirm(b, aDraftId, NOW, () =>
        Promise.resolve({
          userId: b,
          type: TransactionType.EXPENSE,
          amount: Money.fromMajor(99_000),
          description: 'pencurian',
          occurredAt: NOW,
        }),
      );
      expect(attempt.kind).toBe('not_found'); // indistinguishable from a draft that does not exist
      expect(await prisma.transaction.count({ where: { description: 'pencurian' } })).toBe(0);
    });
    it("B submitting the very same photo gets its own draft; A's is unaffected", async () => {
      const mine = await receipts.createDraft({
        userId: b,
        imageSha256: A_SHA,
        extraction: extraction(),
        expiresAt: new Date(NOW.getTime() + 1_800_000),
        now: NOW,
      });
      expect(mine.kind).toBe('created');
      expect((await receipts.findPending(a, NOW))?.id).toBe(aDraftId);
    });
  });

  describe('reset', () => {
    it("wiping B's data leaves every row of A's intact", async () => {
      await new ResetUserDataService(new PrismaUserDataResetRepository(prisma)).reset(b);
      expect(await prisma.transaction.count({ where: { userId: b } })).toBe(0);
      expect(await snapshotOfA()).toBe(before);
    });
  });

  it("after ALL of the above, A's data is exactly what it was", async () => {
    expect(await snapshotOfA()).toBe(before);
  });
});
