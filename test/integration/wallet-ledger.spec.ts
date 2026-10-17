/**
 * REAL PostgreSQL: wallet balances, opening balances and transfers end to end through the real
 * repositories. Balances are never stored, only derived, so the central property tested here is
 * that every ledger reconciles, including under concurrency and across months.
 */
import { SummaryPeriod } from '../../src/modules/parser/domain/parsed-intent';
import { PrismaCategoryRepository } from '../../src/modules/category/infrastructure/prisma-category.repository';
import { PrismaTransactionRepository } from '../../src/modules/transaction/infrastructure/prisma-transaction.repository';
import { PrismaUserRepository } from '../../src/modules/user/infrastructure/prisma-user.repository';
import { WalletOverview, WalletService } from '../../src/modules/wallet/application/wallet.service';
import { PrismaTransferRepository } from '../../src/modules/wallet/infrastructure/prisma-transfer.repository';
import { PrismaService } from '../../src/database/prisma.service';
import { TransactionType, Wallet, WalletMode } from '../../src/shared/domain/enums';
import { Money } from '../../src/shared/utils/money';
import { connectTestPrisma, createUser, resetDatabase } from '../setup/test-db';

const TZ = 'Asia/Jakarta';
const SEPT = new Date('2026-09-15T03:00:00Z');
const OCT = new Date('2026-10-15T03:00:00Z');
const NOV = new Date('2026-11-15T03:00:00Z');

describe('wallet ledger (PostgreSQL)', () => {
  let prisma: PrismaService;
  let transactions: PrismaTransactionRepository;
  let transfers: PrismaTransferRepository;
  let users: PrismaUserRepository;
  let wallets: WalletService;

  beforeAll(async () => {
    prisma = await connectTestPrisma();
    transactions = new PrismaTransactionRepository(prisma);
    transfers = new PrismaTransferRepository(prisma);
    users = new PrismaUserRepository(prisma);
    wallets = new WalletService(
      transactions,
      users,
      new PrismaCategoryRepository(prisma),
      transfers,
    );
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  const newUser = async (): Promise<string> => {
    const u = await createUser(prisma);
    await users.update(u.id, { walletMode: WalletMode.BOTH });
    return u.id;
  };
  const spend = (
    userId: string,
    wallet: Wallet,
    amount: number,
    at: Date,
    type = TransactionType.EXPENSE,
  ) =>
    transactions.create({
      userId,
      type,
      amount: Money.fromMajor(amount),
      description: 'x',
      occurredAt: at,
      wallet,
    });
  const month = (userId: string, now: Date): Promise<WalletOverview> =>
    wallets.overview(userId, SummaryPeriod.Month, now, TZ);
  const line = (o: WalletOverview, w: Wallet) => o.lines.find((l) => l.wallet === w)!;
  const identityHolds = (o: WalletOverview): boolean =>
    o.lines.every((l) =>
      l.startBalance
        .add(l.income)
        .subtract(l.expense)
        .add(l.transferIn)
        .subtract(l.transferOut)
        .equals(l.balance),
    );

  describe('the real account scenario (opening balances 34.000 / 522.000, expense 20.000)', () => {
    it('counts opening balances as income and reconciles every figure', async () => {
      const u = await newUser();
      await wallets.setOpeningBalance(u, Wallet.CASH, Money.fromMajor(34000), SEPT, 'm1');
      await wallets.setOpeningBalance(u, Wallet.DIGITAL, Money.fromMajor(522000), SEPT, 'm2');
      await spend(u, Wallet.DIGITAL, 20000, SEPT);

      const o = await month(u, SEPT);
      expect(line(o, Wallet.CASH).balance.toNumber()).toBe(34000);
      expect(line(o, Wallet.DIGITAL).balance.toNumber()).toBe(502000);
      expect(o.total.toNumber()).toBe(536000);
      expect(line(o, Wallet.CASH).income.toNumber()).toBe(34000);
      expect(line(o, Wallet.DIGITAL).income.toNumber()).toBe(522000);
      expect(line(o, Wallet.DIGITAL).expense.toNumber()).toBe(20000);
      expect(line(o, Wallet.DIGITAL).startBalance.isZero()).toBe(true);
      expect(identityHolds(o)).toBe(true);
    });

    it('carries the balance into the next month as "saldo sebelumnya"', async () => {
      const u = await newUser();
      await wallets.setOpeningBalance(u, Wallet.DIGITAL, Money.fromMajor(522000), SEPT, 'm2');
      await spend(u, Wallet.DIGITAL, 20000, SEPT);

      const oct = await month(u, OCT);
      expect(line(oct, Wallet.DIGITAL).startBalance.toNumber()).toBe(502000);
      expect(line(oct, Wallet.DIGITAL).income.isZero()).toBe(true);
      expect(line(oct, Wallet.DIGITAL).balance.toNumber()).toBe(502000);
      expect(identityHolds(oct)).toBe(true);
    });
  });

  describe('opening balance entries', () => {
    it('replaces the previous one, and zero removes it', async () => {
      const u = await newUser();
      await wallets.setOpeningBalance(u, Wallet.CASH, Money.fromMajor(100), SEPT, 'a');
      await wallets.setOpeningBalance(u, Wallet.CASH, Money.fromMajor(300), SEPT, 'b');
      expect(line(await wallets.current(u), Wallet.CASH).balance.toNumber()).toBe(300);

      await wallets.setOpeningBalance(u, Wallet.CASH, Money.zero(), SEPT, 'c');
      expect(line(await wallets.current(u), Wallet.CASH).balance.toNumber()).toBe(0);
    });

    it('applies the same chat message only once, even when retried concurrently', async () => {
      const u = await newUser();
      await Promise.all(
        Array.from({ length: 8 }, () =>
          wallets.setOpeningBalance(u, Wallet.CASH, Money.fromMajor(500), SEPT, 'same-message'),
        ),
      );
      expect(line(await wallets.current(u), Wallet.CASH).balance.toNumber()).toBe(500);
    });

    it('knows which wallets still lack one', async () => {
      const u = await newUser();
      await wallets.setOpeningBalance(u, Wallet.CASH, Money.fromMajor(1), SEPT, 'a');
      expect(await wallets.walletsWithoutOpening(u, [Wallet.CASH, Wallet.DIGITAL])).toEqual([
        Wallet.DIGITAL,
      ]);
    });
  });

  describe('transfers', () => {
    it('moves money between wallets without changing the total or income/expense', async () => {
      const u = await newUser();
      await wallets.setOpeningBalance(u, Wallet.DIGITAL, Money.fromMajor(500000), SEPT, 'o');
      const before = await month(u, SEPT);

      await wallets.transfer(u, Wallet.DIGITAL, Wallet.CASH, Money.fromMajor(150000), SEPT, 't1');
      const after = await month(u, SEPT);

      expect(line(after, Wallet.CASH).balance.toNumber()).toBe(150000);
      expect(line(after, Wallet.DIGITAL).balance.toNumber()).toBe(350000);
      expect(after.total.equals(before.total)).toBe(true);
      expect(line(after, Wallet.CASH).income.toNumber()).toBe(0); // a transfer is not income
      expect(line(after, Wallet.DIGITAL).expense.toNumber()).toBe(0); // nor an expense
      expect(line(after, Wallet.CASH).transferIn.toNumber()).toBe(150000);
      expect(line(after, Wallet.DIGITAL).transferOut.toNumber()).toBe(150000);
      expect(after.transfers).toHaveLength(1);
      expect(identityHolds(after)).toBe(true);
    });

    it('refuses a transfer to the same wallet at the database level', async () => {
      const u = await newUser();
      await expect(
        wallets.transfer(u, Wallet.CASH, Wallet.CASH, Money.fromMajor(1), SEPT, 'same'),
      ).rejects.toThrow();
      expect(await transfers.hasAny(u)).toBe(false);
    });

    it('records the same message only once', async () => {
      const u = await newUser();
      const first = await wallets.transfer(
        u,
        Wallet.CASH,
        Wallet.DIGITAL,
        Money.fromMajor(10),
        SEPT,
        'k',
      );
      const second = await wallets.transfer(
        u,
        Wallet.CASH,
        Wallet.DIGITAL,
        Money.fromMajor(10),
        SEPT,
        'k',
      );
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(await prisma.transfer.count({ where: { userId: u } })).toBe(1);
    });

    it('stays exact with 30 transfers racing', async () => {
      const u = await newUser();
      await wallets.setOpeningBalance(u, Wallet.DIGITAL, Money.fromMajor(1_000_000), SEPT, 'o');
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          wallets.transfer(
            u,
            Wallet.DIGITAL,
            Wallet.CASH,
            Money.fromMajor(1000),
            SEPT,
            `race-${i}`,
          ),
        ),
      );
      const o = await wallets.current(u);
      expect(line(o, Wallet.CASH).balance.toNumber()).toBe(30000);
      expect(line(o, Wallet.DIGITAL).balance.toNumber()).toBe(970000);
    });

    it('undoes the latest transfer, and only for its owner', async () => {
      const a = await newUser();
      const b = await newUser();
      await wallets.transfer(a, Wallet.CASH, Wallet.DIGITAL, Money.fromMajor(100), SEPT, 't');
      const latest = (await wallets.getLastTransfer(a))!;

      await expect(transfers.softDelete(b, latest.id)).rejects.toThrow('not found');
      expect(await transfers.hasAny(a)).toBe(true);

      await wallets.deleteLastTransfer(a);
      expect(await transfers.hasAny(a)).toBe(false);
      expect(await wallets.deleteLastTransfer(a)).toBeNull();
    });
  });

  describe('reconciliation across months (randomised, reproducible)', () => {
    /** Tiny deterministic PRNG so a failure is reproducible. */
    const prng = (seed: number) => () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    it('always adds up, and one month closes exactly where the next one opens', async () => {
      const u = await newUser();
      const rnd = prng(20261012);
      const dates = [
        new Date('2026-09-10T03:00:00Z'),
        new Date('2026-10-12T03:00:00Z'),
        new Date('2026-11-09T03:00:00Z'),
      ];

      for (const at of dates) {
        for (let i = 0; i < 12; i++) {
          const wallet = rnd() < 0.5 ? Wallet.CASH : Wallet.DIGITAL;
          const amount = 1 + Math.floor(rnd() * 500_000);
          const kind = rnd();
          if (kind < 0.45) await spend(u, wallet, amount, at);
          else if (kind < 0.8) await spend(u, wallet, amount, at, TransactionType.INCOME);
          else {
            const to = wallet === Wallet.CASH ? Wallet.DIGITAL : Wallet.CASH;
            await transfers.create({
              userId: u,
              from: wallet,
              to,
              amount: Money.fromMajor(amount),
              occurredAt: at,
            });
          }
        }
      }

      const [sep, oct, nov] = [await month(u, SEPT), await month(u, OCT), await month(u, NOV)];
      for (const o of [sep, oct, nov]) expect(identityHolds(o)).toBe(true);
      for (const w of [Wallet.CASH, Wallet.DIGITAL]) {
        expect(line(oct, w).startBalance.equals(line(sep, w).balance)).toBe(true);
        expect(line(nov, w).startBalance.equals(line(oct, w).balance)).toBe(true);
      }
      // The November closing balance is the all-time balance.
      const now = await wallets.current(u);
      for (const w of [Wallet.CASH, Wallet.DIGITAL]) {
        expect(line(nov, w).balance.equals(line(now, w).balance)).toBe(true);
      }
    });

    it('shows a past month as of its own end, not as of today', async () => {
      const u = await newUser();
      await spend(u, Wallet.CASH, 1000, new Date('2026-09-10T03:00:00Z'), TransactionType.INCOME);
      await spend(u, Wallet.CASH, 9000, new Date('2026-10-10T03:00:00Z'), TransactionType.INCOME);

      const sep = await month(u, SEPT);
      expect(line(sep, Wallet.CASH).balance.toNumber()).toBe(1000); // October's 9.000 must not leak in
      expect((await wallets.current(u)).total.toNumber()).toBe(10000);
    });
  });

  describe('isolation and rules', () => {
    it("one user's wallet activity never affects another's balances", async () => {
      const a = await newUser();
      const b = await newUser();
      await wallets.setOpeningBalance(a, Wallet.CASH, Money.fromMajor(777), SEPT, 'a');
      await wallets.transfer(a, Wallet.CASH, Wallet.DIGITAL, Money.fromMajor(7), SEPT, 'ta');

      expect((await wallets.current(b)).total.isZero()).toBe(true);
      expect(await wallets.getLastTransfer(b)).toBeNull();
    });

    it('refuses to turn off a wallet that holds data, and accepts it when empty', async () => {
      const u = await newUser();
      await wallets.setOpeningBalance(u, Wallet.DIGITAL, Money.fromMajor(5), SEPT, 'o');
      expect(await wallets.setMode(u, WalletMode.CASH)).toEqual({
        ok: false,
        blocked: Wallet.DIGITAL,
      });
      expect(await wallets.setMode(u, WalletMode.DIGITAL)).toEqual({ ok: true });
    });

    it('does not let a user with no activity see wallet detail', async () => {
      const u = await createUser(prisma);
      expect((await wallets.current(u.id)).enabled).toBe(false);
    });
  });
});
