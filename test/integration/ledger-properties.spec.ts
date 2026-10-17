/**
 * Ledger properties on real PostgreSQL.
 *
 * Balances are never stored; they are derived from income, expense and transfer rows. So the whole
 * correctness question is: for ANY sequence of operations, does the derived state equal what an
 * independent model says? This generates random sequences (seeded, so a failure replays) and compares
 * the database's answer with a plain BigInt model, then attacks the race-sensitive paths directly.
 *
 * Design decision recorded here, because the tests rely on it: a wallet balance MAY go negative. The bot is
 * a record-keeping assistant; refusing to record a real expense because an earlier one was never entered
 * would make the books wrong in a worse way. Transfers, however, always conserve the total.
 */
import { PrismaService } from '../../src/database/prisma.service';
import { SummaryPeriod } from '../../src/modules/parser/domain/parsed-intent';
import { PrismaCategoryRepository } from '../../src/modules/category/infrastructure/prisma-category.repository';
import { PrismaTransactionRepository } from '../../src/modules/transaction/infrastructure/prisma-transaction.repository';
import { PrismaUserRepository } from '../../src/modules/user/infrastructure/prisma-user.repository';
import { WalletService } from '../../src/modules/wallet/application/wallet.service';
import { PrismaTransferRepository } from '../../src/modules/wallet/infrastructure/prisma-transfer.repository';
import { TransactionType, Wallet, WalletMode } from '../../src/shared/domain/enums';
import { Money } from '../../src/shared/utils/money';
import { connectTestPrisma, createUser, resetDatabase } from '../setup/test-db';

const TZ = 'Asia/Jakarta';
const NOW = new Date('2026-07-15T05:00:00.000Z');

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ledger properties (PostgreSQL)', () => {
  let prisma: PrismaService;
  let tx: PrismaTransactionRepository;
  let transfers: PrismaTransferRepository;
  let users: PrismaUserRepository;
  let wallets: WalletService;

  beforeAll(async () => {
    prisma = await connectTestPrisma();
    tx = new PrismaTransactionRepository(prisma);
    transfers = new PrismaTransferRepository(prisma);
    users = new PrismaUserRepository(prisma);
    wallets = new WalletService(tx, users, new PrismaCategoryRepository(prisma), transfers);
  });
  afterAll(async () => prisma.$disconnect());
  beforeEach(async () => resetDatabase(prisma));

  const newUser = async (): Promise<string> => {
    const u = await createUser(prisma);
    await users.update(u.id, { walletMode: WalletMode.BOTH });
    return u.id;
  };
  const balances = async (userId: string): Promise<Record<Wallet, bigint>> => {
    const o = await wallets.current(userId);
    const get = (w: Wallet) => o.lines.find((l) => l.wallet === w)!.balance.minorUnits;
    return { [Wallet.CASH]: get(Wallet.CASH), [Wallet.DIGITAL]: get(Wallet.DIGITAL) };
  };

  describe('random sequences agree with an independent model', () => {
    type Live =
      | { kind: 'tx'; id: string; wallet: Wallet; signed: bigint }
      | { kind: 'tr'; id: string; from: Wallet; to: Wallet; amount: bigint };

    it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i: 40 random operations', async (seed) => {
      const r = rng(1_000 + seed);
      const userId = await newUser();
      const live: Live[] = [];
      const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
      const wallet = (): Wallet => (r() < 0.5 ? Wallet.CASH : Wallet.DIGITAL);
      const amount = (): bigint => BigInt(1 + Math.floor(r() * 2_000_000));

      for (let i = 0; i < 40; i += 1) {
        const roll = r();
        if (roll < 0.35) {
          const w = wallet();
          const a = amount();
          const row = await tx.create({
            userId,
            type: TransactionType.INCOME,
            amount: Money.fromMajor(Number(a)),
            description: 'in',
            occurredAt: NOW,
            wallet: w,
          });
          live.push({ kind: 'tx', id: row!.id, wallet: w, signed: a * 100n });
        } else if (roll < 0.6) {
          const w = wallet();
          const a = amount();
          const row = await tx.create({
            userId,
            type: TransactionType.EXPENSE,
            amount: Money.fromMajor(Number(a)),
            description: 'out',
            occurredAt: NOW,
            wallet: w,
          });
          live.push({ kind: 'tx', id: row!.id, wallet: w, signed: -a * 100n });
        } else if (roll < 0.85) {
          const from = wallet();
          const to = from === Wallet.CASH ? Wallet.DIGITAL : Wallet.CASH;
          const a = amount();
          const row = await wallets.transfer(
            userId,
            from,
            to,
            Money.fromMajor(Number(a)),
            NOW,
            null,
          );
          live.push({ kind: 'tr', id: row!.id, from, to, amount: a * 100n });
        } else if (live.length > 0) {
          const victim = pick(live);
          if (victim.kind === 'tx') await tx.softDelete(userId, victim.id);
          else await transfers.softDelete(userId, victim.id);
          live.splice(live.indexOf(victim), 1);
        }
      }

      const model = { [Wallet.CASH]: 0n, [Wallet.DIGITAL]: 0n };
      let income = 0n;
      for (const e of live) {
        if (e.kind === 'tx') {
          model[e.wallet] += e.signed;
          income += e.signed;
        } else {
          model[e.from] -= e.amount;
          model[e.to] += e.amount;
        }
      }
      const actual = await balances(userId);
      expect(actual[Wallet.CASH]).toBe(model[Wallet.CASH]);
      expect(actual[Wallet.DIGITAL]).toBe(model[Wallet.DIGITAL]);
      // transfers conserve value: the total is exactly income minus expense, whatever was moved
      expect(actual[Wallet.CASH] + actual[Wallet.DIGITAL]).toBe(income);
    });
  });

  describe('races', () => {
    it('two simultaneous transfers out of the same wallet both complete, and the total is conserved', async () => {
      const userId = await newUser();
      await tx.create({
        userId,
        type: TransactionType.INCOME,
        amount: Money.fromMajor(150),
        description: 'saldo',
        occurredAt: NOW,
        wallet: Wallet.CASH,
      });

      const results = await Promise.all([
        wallets.transfer(userId, Wallet.CASH, Wallet.DIGITAL, Money.fromMajor(100), NOW, 'race:1'),
        wallets.transfer(userId, Wallet.CASH, Wallet.DIGITAL, Money.fromMajor(100), NOW, 'race:2'),
      ]);
      expect(results.every((x) => x !== null)).toBe(true);
      const b = await balances(userId);
      expect(b[Wallet.CASH]).toBe(-5_000n); // overdraft is allowed by design; see the file header
      expect(b[Wallet.DIGITAL]).toBe(20_000n);
      expect(b[Wallet.CASH] + b[Wallet.DIGITAL]).toBe(15_000n); // nothing created, nothing lost
    });

    it('the same chat message delivered 25 times at once creates exactly one transfer', async () => {
      const userId = await newUser();
      const outcomes = await Promise.all(
        Array.from({ length: 25 }, () =>
          wallets.transfer(userId, Wallet.CASH, Wallet.DIGITAL, Money.fromMajor(500), NOW, 'dup:1'),
        ),
      );
      expect(outcomes.filter((o) => o !== null)).toHaveLength(1);
      expect(await prisma.transfer.count({ where: { userId } })).toBe(1);
    });

    it('the same chat message recorded 25 times at once creates exactly one transaction', async () => {
      const userId = await newUser();
      const outcomes = await Promise.all(
        Array.from({ length: 25 }, () =>
          tx.create({
            userId,
            type: TransactionType.EXPENSE,
            amount: Money.fromMajor(1_000),
            description: 'kopi',
            occurredAt: NOW,
            messageId: 'dup:2',
          }),
        ),
      );
      expect(outcomes.filter((o) => o !== null)).toHaveLength(1);
      expect(await prisma.transaction.count({ where: { userId } })).toBe(1);
    });

    it('a batch that repeats an already stored key is all-or-nothing and never doubles a row', async () => {
      const userId = await newUser();
      await tx.create({
        userId,
        type: TransactionType.EXPENSE,
        amount: Money.fromMajor(1),
        description: 'a',
        occurredAt: NOW,
        messageId: 'k:0',
      });
      const inputs = [0, 1, 2].map((i) => ({
        userId,
        type: TransactionType.EXPENSE,
        amount: Money.fromMajor(10 + i),
        description: `b${i}`,
        occurredAt: NOW,
        messageId: `k:${i}`,
      }));
      const run = await Promise.all([tx.createMany(inputs), tx.createMany(inputs)]);
      // k:0 already existed, k:1 and k:2 are created by exactly one of the two concurrent batches
      const created = run.flat().filter((x) => x !== null);
      expect(created).toHaveLength(2);
      expect(await prisma.transaction.count({ where: { userId } })).toBe(3);
    });

    it('deleting the same transaction 12 times at once deletes it once and reports the rest', async () => {
      const userId = await newUser();
      const row = await tx.create({
        userId,
        type: TransactionType.EXPENSE,
        amount: Money.fromMajor(9_000),
        description: 'x',
        occurredAt: NOW,
        wallet: Wallet.CASH,
      });
      const settled = await Promise.allSettled(
        Array.from({ length: 12 }, () => tx.softDelete(userId, row!.id)),
      );
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(11);
      expect((await balances(userId))[Wallet.CASH]).toBe(0n);
      const stored = await prisma.transaction.findUniqueOrThrow({ where: { id: row!.id } });
      expect(stored.deletedAt).not.toBeNull(); // still there, marked once
    });

    it('a balance read during a burst of writes always reconciles with itself', async () => {
      const userId = await newUser();
      const writes = Array.from({ length: 60 }, (_, i) =>
        i % 3 === 0
          ? wallets.transfer(
              userId,
              Wallet.CASH,
              Wallet.DIGITAL,
              Money.fromMajor(100 + i),
              NOW,
              `w:${i}`,
            )
          : tx.create({
              userId,
              type: i % 2 ? TransactionType.INCOME : TransactionType.EXPENSE,
              amount: Money.fromMajor(50 + i),
              description: 'w',
              occurredAt: NOW,
              wallet: i % 2 ? Wallet.CASH : Wallet.DIGITAL,
              messageId: `w:${i}`,
            }),
      );
      const reads = Array.from({ length: 30 }, () =>
        wallets.overview(userId, SummaryPeriod.Month, NOW, TZ),
      );
      const [overviews] = await Promise.all([Promise.all(reads), Promise.all(writes)]);
      for (const o of overviews) {
        for (const l of o.lines) {
          expect(
            l.startBalance
              .add(l.income)
              .subtract(l.expense)
              .add(l.transferIn)
              .subtract(l.transferOut)
              .equals(l.balance),
          ).toBe(true);
        }
      }
      // and after the burst everything is in the database exactly once
      expect(await prisma.transaction.count({ where: { userId } })).toBe(40);
      expect(await prisma.transfer.count({ where: { userId } })).toBe(20);
    });
  });

  describe('the database refuses what the code must never produce', () => {
    it('rejects non-positive, oversized and same-wallet rows even when the application is bypassed', async () => {
      const userId = await newUser();
      const raw = (sql: string) => prisma.$executeRawUnsafe(sql);
      await expect(
        raw(
          `INSERT INTO transactions (id, user_id, type, amount_minor, description, occurred_at, updated_at) VALUES ('p1','${userId}','EXPENSE', 0, 'x', now(), now())`,
        ),
      ).rejects.toThrow();
      await expect(
        raw(
          `INSERT INTO transactions (id, user_id, type, amount_minor, description, occurred_at, updated_at) VALUES ('p2','${userId}','EXPENSE', -5, 'x', now(), now())`,
        ),
      ).rejects.toThrow();
      await expect(
        raw(
          `INSERT INTO transactions (id, user_id, type, amount_minor, description, occurred_at, updated_at) VALUES ('p3','${userId}','EXPENSE', 1000000000000001, 'x', now(), now())`,
        ),
      ).rejects.toThrow();
      await expect(
        raw(
          `INSERT INTO transfers (id, user_id, from_wallet, to_wallet, amount_minor, occurred_at) VALUES ('p4','${userId}','CASH','CASH', 100, now())`,
        ),
      ).rejects.toThrow();
      await expect(
        raw(
          `INSERT INTO transfers (id, user_id, from_wallet, to_wallet, amount_minor, occurred_at) VALUES ('p5','${userId}','CASH','DIGITAL', 0, now())`,
        ),
      ).rejects.toThrow();
      expect(await prisma.transaction.count({ where: { userId } })).toBe(0);
      expect(await prisma.transfer.count({ where: { userId } })).toBe(0);
    });
  });
});
