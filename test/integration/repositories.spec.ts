/**
 * REAL PostgreSQL: users, categories, budgets, conversations, user-data reset and health checks.
 */
import { PrismaService } from '../../src/database/prisma.service';
import {
  CategorySeederService,
  systemCategoryId,
} from '../../src/modules/category/category-seeder.service';
import { PrismaCategoryRepository } from '../../src/modules/category/infrastructure/prisma-category.repository';
import { SYSTEM_CATEGORIES } from '../../src/modules/category/seed-data';
import { PrismaBudgetRepository } from '../../src/modules/budget/infrastructure/prisma-budget.repository';
import { PrismaConversationRepository } from '../../src/modules/conversation/infrastructure/prisma-conversation.repository';
import { HealthService } from '../../src/modules/health/health.service';
import { PrismaTransactionRepository } from '../../src/modules/transaction/infrastructure/prisma-transaction.repository';
import { ResetUserDataService } from '../../src/modules/user/application/reset-user-data.service';
import { PrismaUserDataResetRepository } from '../../src/modules/user/infrastructure/prisma-user-data-reset.repository';
import { PrismaUserRepository } from '../../src/modules/user/infrastructure/prisma-user.repository';
import { PrismaTransferRepository } from '../../src/modules/wallet/infrastructure/prisma-transfer.repository';
import {
  BudgetPeriod,
  ConversationState,
  TransactionType,
  Wallet,
  WalletMode,
} from '../../src/shared/domain/enums';
import { Money } from '../../src/shared/utils/money';
import { connectTestPrisma, createUser, resetDatabase } from '../setup/test-db';

describe('repositories (PostgreSQL)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = await connectTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  describe('users', () => {
    it('creates one user when ten first messages arrive at once', async () => {
      const users = new PrismaUserRepository(prisma);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => users.findOrCreate({ telegramId: '555', chatId: '9' })),
      );

      expect(await prisma.user.count()).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1); // exactly one gets the onboarding
      expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
    });

    it('keeps the reply chat id fresh and persists wallet settings', async () => {
      const users = new PrismaUserRepository(prisma);
      const { user } = await users.findOrCreate({ telegramId: '777', chatId: '1' });
      const again = await users.findOrCreate({ telegramId: '777', chatId: '2' });
      expect(again.created).toBe(false);
      expect(again.user.chatId).toBe('2');

      const updated = await users.update(user.id, {
        walletMode: WalletMode.BOTH,
        defaultWallet: Wallet.DIGITAL,
      });
      expect((await users.findById(user.id))?.walletMode).toBe(WalletMode.BOTH);
      expect(updated.defaultWallet).toBe(Wallet.DIGITAL);
      await expect(
        users.update('00000000-0000-0000-0000-000000000000', { isOnboarded: true }),
      ).rejects.toThrow('not found');
    });
  });

  describe('categories', () => {
    it('seeds the system categories once, even with several starts at the same time', async () => {
      await resetDatabase(prisma, false);
      await Promise.all(Array.from({ length: 5 }, () => new CategorySeederService(prisma).seed()));
      expect(await prisma.category.count({ where: { userId: null } })).toBe(
        SYSTEM_CATEGORIES.length,
      );
    });

    it('keeps keywords a user edited when seeding runs again', async () => {
      await prisma.category.update({
        where: { id: systemCategoryId({ type: TransactionType.EXPENSE, name: 'Makanan' }) },
        data: { keywords: ['martabak-spesial'] },
      });
      await new CategorySeederService(prisma).seed();
      const row = await prisma.category.findUniqueOrThrow({
        where: { id: systemCategoryId({ type: TransactionType.EXPENSE, name: 'Makanan' }) },
      });
      expect(row.keywords).toEqual(['martabak-spesial']);
    });

    it("resolves keywords to system categories, prefers a user's own, and hides other users'", async () => {
      const repo = new PrismaCategoryRepository(prisma);
      const a = await createUser(prisma);
      const b = await createUser(prisma);

      expect(
        (await repo.findByKeyword('kopi', { type: TransactionType.EXPENSE, userId: a.id }))?.name,
      ).toBe('Makanan');

      await prisma.category.create({
        data: { id: 'a-hobi', userId: a.id, name: 'Hobi A', type: 'EXPENSE', keywords: ['kopi'] },
      });
      expect(
        (await repo.findByKeyword('kopi', { type: TransactionType.EXPENSE, userId: a.id }))?.name,
      ).toBe('Hobi A');
      // User B never sees A's category, neither by keyword nor in the list.
      expect(
        (await repo.findByKeyword('kopi', { type: TransactionType.EXPENSE, userId: b.id }))?.name,
      ).toBe('Makanan');
      expect((await repo.findAllForUser(b.id)).some((c) => c.id === 'a-hobi')).toBe(false);
      expect((await repo.findAllForUser(a.id)).some((c) => c.id === 'a-hobi')).toBe(true);
    });

    it('finds a category by name and type, system or personal', async () => {
      const repo = new PrismaCategoryRepository(prisma);
      expect(
        (await repo.findByNameAndType('Saldo Awal', TransactionType.INCOME, null))?.isSystem,
      ).toBe(true);
      expect(await repo.findByNameAndType('Saldo Awal', TransactionType.EXPENSE, null)).toBeNull();
    });
  });

  describe('budgets', () => {
    it('keeps one budget per (user, category, period) and updates it in place', async () => {
      const repo = new PrismaBudgetRepository(prisma);
      const u = await createUser(prisma);
      const food = systemCategoryId({ type: TransactionType.EXPENSE, name: 'Makanan' });

      const first = await repo.upsert({
        userId: u.id,
        categoryId: food,
        amount: Money.fromMajor(100),
        period: BudgetPeriod.MONTHLY,
      });
      const second = await repo.upsert({
        userId: u.id,
        categoryId: food,
        amount: Money.fromMajor(250),
        period: BudgetPeriod.MONTHLY,
        alertThreshold: 90,
      });

      expect(second.id).toBe(first.id);
      expect(second.amount.toNumber()).toBe(250);
      expect(second.alertThreshold).toBe(90);
      expect(await prisma.budget.count({ where: { userId: u.id } })).toBe(1);
    });

    it('supports one overall budget, even when upserted concurrently', async () => {
      const repo = new PrismaBudgetRepository(prisma);
      const u = await createUser(prisma);
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          repo.upsert({
            userId: u.id,
            amount: Money.fromMajor(100 + i),
            period: BudgetPeriod.WEEKLY,
          }),
        ),
      );
      expect(await prisma.budget.count({ where: { userId: u.id, categoryId: null } })).toBe(1);
      expect(await repo.findByCategoryPeriod(u.id, null, BudgetPeriod.WEEKLY)).not.toBeNull();
    });

    it('only lets the owner delete a budget', async () => {
      const repo = new PrismaBudgetRepository(prisma);
      const a = await createUser(prisma);
      const b = await createUser(prisma);
      const budget = await repo.upsert({
        userId: a.id,
        amount: Money.fromMajor(10),
        period: BudgetPeriod.DAILY,
      });

      await repo.delete(b.id, budget.id);
      expect(await repo.findForUser(a.id)).toHaveLength(1);
      await repo.delete(a.id, budget.id);
      expect(await repo.findForUser(a.id)).toHaveLength(0);
    });
  });

  describe('conversations', () => {
    it('stores, expires and clears the context, one row per user', async () => {
      const repo = new PrismaConversationRepository(prisma);
      const u = await createUser(prisma);
      const now = new Date('2026-10-12T03:00:00Z');

      await repo.set({
        userId: u.id,
        state: ConversationState.AWAITING_WALLET,
        payload: { batch: [{ description: 'ayam' }] },
        expiresAt: new Date(now.getTime() + 300_000),
      });
      const active = await repo.getActive(u.id, now);
      expect(active?.state).toBe(ConversationState.AWAITING_WALLET);
      expect(active?.payload).toEqual({ batch: [{ description: 'ayam' }] });

      expect(await repo.getActive(u.id, new Date(now.getTime() + 301_000))).toBeNull(); // expired
      await repo.clear(u.id);
      expect(await repo.getActive(u.id, now)).toBeNull();
      expect(await prisma.conversation.count({ where: { userId: u.id } })).toBe(1);
    });

    it('survives concurrent writers without creating two contexts', async () => {
      const repo = new PrismaConversationRepository(prisma);
      const u = await createUser(prisma);
      await Promise.all(
        Array.from({ length: 8 }, () =>
          repo.set({
            userId: u.id,
            state: ConversationState.AWAITING_AMOUNT,
            payload: null,
            expiresAt: null,
          }),
        ),
      );
      expect(await prisma.conversation.count({ where: { userId: u.id } })).toBe(1);
    });
  });

  describe('reset user data', () => {
    const seedData = async (userId: string) => {
      const tx = new PrismaTransactionRepository(prisma);
      const tr = new PrismaTransferRepository(prisma);
      await tx.create({
        userId,
        type: TransactionType.EXPENSE,
        amount: Money.fromMajor(1),
        description: 'x',
        occurredAt: new Date(),
      });
      await tr.create({
        userId,
        from: Wallet.CASH,
        to: Wallet.DIGITAL,
        amount: Money.fromMajor(1),
        occurredAt: new Date(),
      });
      await prisma.budget.create({
        data: { userId, scopeKey: 'ALL', period: 'MONTHLY', amountMinor: 100n },
      });
      await prisma.category.create({
        data: { id: `own-${userId}`, userId, name: 'Pribadi', type: 'EXPENSE' },
      });
      await prisma.conversation.create({ data: { userId, state: 'AWAITING_AMOUNT' } });
      await prisma.receiptDraft.create({
        data: {
          userId,
          imageSha256: userId.replace(/-/g, '').padEnd(64, '0'),
          extraction: {},
          expiresAt: new Date(),
        },
      });
    };
    const rows = async (userId: string) => [
      await prisma.transaction.count({ where: { userId } }),
      await prisma.transfer.count({ where: { userId } }),
      await prisma.budget.count({ where: { userId } }),
      await prisma.category.count({ where: { userId } }),
      await prisma.conversation.count({ where: { userId } }),
      await prisma.receiptDraft.count({ where: { userId } }),
    ];

    it("wipes one user's data and nothing of anyone else's", async () => {
      const a = await createUser(prisma);
      const b = await createUser(prisma);
      await seedData(a.id);
      await seedData(b.id);

      await new ResetUserDataService(new PrismaUserDataResetRepository(prisma)).reset(a.id);

      expect(await rows(a.id)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(await rows(b.id)).toEqual([1, 1, 1, 1, 1, 1]); // untouched
      expect(await prisma.user.count()).toBe(2); // the account itself stays
      expect(await prisma.category.count({ where: { userId: null } })).toBe(
        SYSTEM_CATEGORIES.length,
      );
    });

    it('is all-or-nothing: a failure part-way leaves every table as it was', async () => {
      const u = await createUser(prisma);
      await seedData(u.id);
      // Make the LAST delete in the transaction (categories) fail.
      await prisma.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION fail_category_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END; $$ LANGUAGE plpgsql`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER fail_category_delete BEFORE DELETE ON categories FOR EACH ROW EXECUTE FUNCTION fail_category_delete()`,
      );
      try {
        await expect(
          new ResetUserDataService(new PrismaUserDataResetRepository(prisma)).reset(u.id),
        ).rejects.toThrow();
        expect(await rows(u.id)).toEqual([1, 1, 1, 1, 1, 1]); // nothing was deleted
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_category_delete ON categories`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS fail_category_delete()`);
      }
    });
  });

  describe('health', () => {
    it('reports ready when PostgreSQL answers and every migration is applied', async () => {
      const report = await new HealthService(prisma).ready();
      expect(report.status).toBe('ok');
      expect(report.checks.database.status).toBe('up');
      expect(report.checks.migrations.status).toBe('up');
    });

    it('reports NOT ready when a migration on disk is not applied', async () => {
      const saved = await prisma.$queryRaw<Array<{ id: string; migration_name: string }>>`
        SELECT id, migration_name FROM _prisma_migrations`;
      await prisma.$executeRawUnsafe(`UPDATE _prisma_migrations SET finished_at = NULL`);
      try {
        const report = await new HealthService(prisma).ready();
        expect(report.status).toBe('down');
        expect(report.checks.migrations.status).toBe('down');
        expect(report.checks.migrations.detail).toContain('prisma:deploy');
      } finally {
        await prisma.$executeRawUnsafe(
          `UPDATE _prisma_migrations SET finished_at = now() WHERE finished_at IS NULL`,
        );
        expect(saved.length).toBeGreaterThan(0);
      }
    });

    it('is live without touching the database', () => {
      const health = new HealthService({
        ping: () => Promise.reject(new Error('down')),
      } as unknown as PrismaService);
      expect(health.live().status).toBe('ok');
    });

    it('reports the database as down without leaking details', async () => {
      const broken = {
        ping: () => Promise.reject(new Error('password authentication failed for user "x"')),
      };
      const report = await new HealthService(broken as unknown as PrismaService).ready();
      expect(report.status).toBe('down');
      expect(JSON.stringify(report)).not.toContain('password');
    });
  });
});
