import { CategoryRepository } from 'src/modules/category/domain/category.repository';
import { SummaryPeriod } from 'src/modules/parser/domain/parsed-intent';
import { TransactionRepository } from 'src/modules/transaction/domain/transaction.repository';
import { UserEntity } from 'src/modules/user/domain/user.entity';
import { UserRepository } from 'src/modules/user/domain/user.repository';
import { TransactionType, Wallet, WalletMode } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';
import { TransferEntity } from '../domain/transfer.entity';
import { TransferRepository } from '../domain/transfer.repository';
import { OPENING_BALANCE_NOTE, WalletService } from './wallet.service';

/**
 * Unit tests with mocked repositories: the wiring and decisions of WalletService. The arithmetic
 * itself (balances, windows, reconciliation, concurrency) is proven against real PostgreSQL in
 * test/integration/wallet-ledger.spec.ts.
 */
const zero = () => ({ income: Money.zero(), expense: Money.zero() });
const noTransfers = () => ({
  [Wallet.CASH]: { in: Money.zero(), out: Money.zero() },
  [Wallet.DIGITAL]: { in: Money.zero(), out: Money.zero() },
});

function user(over: Partial<UserEntity> = {}): UserEntity {
  return {
    id: 'u1',
    telegramId: '1',
    chatId: '1',
    displayName: null,
    currency: 'IDR',
    timezone: 'Asia/Jakarta',
    isOnboarded: true,
    walletMode: null,
    defaultWallet: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('WalletService', () => {
  let transactions: jest.Mocked<TransactionRepository>;
  let users: jest.Mocked<UserRepository>;
  let categories: jest.Mocked<CategoryRepository>;
  let transfers: jest.Mocked<TransferRepository>;
  let service: WalletService;

  beforeEach(() => {
    transactions = {
      sumByWallet: jest.fn().mockResolvedValue({
        [Wallet.CASH]: { income: Money.fromMajor(500000), expense: Money.fromMajor(100000) },
        [Wallet.DIGITAL]: { income: Money.zero(), expense: Money.fromMajor(50000) },
      }),
      sumByCategory: jest.fn().mockResolvedValue([]),
      hasExplicitWallet: jest.fn().mockResolvedValue(false),
      hasTransactionsInWallet: jest.fn().mockResolvedValue(false),
      findByNote: jest.fn().mockResolvedValue([]),
      replaceMarked: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<TransactionRepository>;
    users = {
      findById: jest.fn().mockResolvedValue(user()),
      update: jest.fn(),
    } as unknown as jest.Mocked<UserRepository>;
    categories = {
      findById: jest.fn().mockResolvedValue({ name: 'Makanan', icon: '🍜' }),
      findByNameAndType: jest.fn().mockResolvedValue({ id: 'system-income-saldo-awal' }),
    } as unknown as jest.Mocked<CategoryRepository>;
    transfers = {
      create: jest.fn(),
      findLatestForUser: jest.fn(),
      softDelete: jest.fn().mockResolvedValue(undefined),
      existsByMessageId: jest.fn().mockResolvedValue(false),
      findManyInRange: jest.fn().mockResolvedValue([]),
      sumByWallet: jest.fn().mockResolvedValue(noTransfers()),
      hasAny: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<TransferRepository>;
    service = new WalletService(transactions, users, categories, transfers);
  });

  describe('balances', () => {
    it('derives each balance from income - expense (+/- transfers), never from stored values', async () => {
      transfers.sumByWallet.mockResolvedValue({
        [Wallet.CASH]: { in: Money.fromMajor(100000), out: Money.zero() },
        [Wallet.DIGITAL]: { in: Money.zero(), out: Money.fromMajor(100000) },
      });
      const o = await service.current('u1');

      const [cash, digital] = o.lines;
      expect(cash.balance.toNumber()).toBe(500000); // 500.000 - 100.000 + 100.000
      expect(digital.balance.toNumber()).toBe(-150000); // 0 - 50.000 - 100.000
      expect(o.total.toNumber()).toBe(350000); // a transfer never changes the total
    });

    it('asks for the window first, then everything up to its end (from the beginning of time)', async () => {
      await service.overview(
        'u1',
        SummaryPeriod.Month,
        new Date('2026-08-15T03:00:00Z'),
        'Asia/Jakarta',
      );

      const [window, upToEnd] = transactions.sumByWallet.mock.calls.map((c) => c[1]!);
      expect(window.start.getTime()).toBeGreaterThan(0);
      expect(upToEnd.start.getTime()).toBe(0);
      expect(upToEnd.end.getTime()).toBe(window.end.getTime());
    });

    it('rewinds the end balance by the window movements to get the starting balance', async () => {
      users.findById.mockResolvedValue(user({ walletMode: WalletMode.BOTH }));
      transactions.sumByWallet.mockImplementation((_u, range) =>
        Promise.resolve(
          range && range.start.getTime() > 0
            ? {
                [Wallet.CASH]: { income: Money.fromMajor(50000), expense: Money.fromMajor(20000) },
                [Wallet.DIGITAL]: zero(),
              }
            : {
                [Wallet.CASH]: { income: Money.fromMajor(200000), expense: Money.fromMajor(80000) },
                [Wallet.DIGITAL]: zero(),
              },
        ),
      );
      transfers.sumByWallet.mockImplementation((_u, range) =>
        Promise.resolve({
          [Wallet.CASH]:
            range && range.start.getTime() > 0
              ? { in: Money.fromMajor(30000), out: Money.fromMajor(5000) }
              : { in: Money.fromMajor(40000), out: Money.fromMajor(15000) },
          [Wallet.DIGITAL]: { in: Money.zero(), out: Money.zero() },
        }),
      );

      const o = await service.overview(
        'u1',
        SummaryPeriod.Month,
        new Date('2026-09-15T03:00:00Z'),
        'Asia/Jakarta',
      );
      const cash = o.lines[0];

      expect(cash.balance.toNumber()).toBe(145000); // 200.000 - 80.000 + 40.000 - 15.000
      expect(cash.startBalance.toNumber()).toBe(90000); // 145.000 - 50.000 + 20.000 - 30.000 + 5.000
      expect(
        cash.startBalance
          .add(cash.income)
          .subtract(cash.expense)
          .add(cash.transferIn)
          .subtract(cash.transferOut)
          .equals(cash.balance),
      ).toBe(true);
    });

    it('adds expense categories per wallet to the overview, only for wallet users', async () => {
      users.findById.mockResolvedValue(user({ defaultWallet: Wallet.CASH }));
      transactions.sumByCategory.mockImplementation((_u, _r, _t, wallet) =>
        Promise.resolve(
          wallet === Wallet.CASH ? [{ categoryId: 'cat-food', total: Money.fromMajor(75000) }] : [],
        ),
      );
      const o = await service.overview('u1', SummaryPeriod.Month, new Date(), 'Asia/Jakarta');
      expect(o.lines[0].categories).toEqual([
        { name: 'Makanan', icon: '🍜', total: Money.fromMajor(75000) },
      ]);
      expect(o.lines[1].categories).toEqual([]);

      users.findById.mockResolvedValue(user());
      transactions.sumByCategory.mockClear();
      await service.overview('u1', SummaryPeriod.Month, new Date(), 'Asia/Jakarta');
      expect(transactions.sumByCategory).not.toHaveBeenCalled();
    });
  });

  describe('wallet mode', () => {
    it('is off for a user who never chose or used wallets', async () => {
      const o = await service.current('u1');
      expect(o.mode).toBeNull();
      expect(o.enabled).toBe(false);
      expect(o.lines).toHaveLength(2);
    });

    it.each([
      [
        'a default wallet',
        () => users.findById.mockResolvedValue(user({ defaultWallet: Wallet.CASH })),
      ],
      [
        'an explicit-wallet transaction',
        () => transactions.hasExplicitWallet.mockResolvedValue(true),
      ],
      ['a transfer', () => transfers.hasAny.mockResolvedValue(true)],
    ])('treats a legacy user with %s as BOTH', async (_name, arrange) => {
      arrange();
      expect((await service.current('u1')).mode).toBe(WalletMode.BOTH);
    });

    it('is on as soon as a mode is chosen, and only reports the active wallet', async () => {
      users.findById.mockResolvedValue(user({ walletMode: WalletMode.CASH }));
      const o = await service.current('u1');
      expect(o.enabled).toBe(true);
      expect(o.lines.map((l) => l.wallet)).toEqual([Wallet.CASH]);
      expect(o.total.toNumber()).toBe(400000);
    });

    it('accepts any mode for an empty user, making a single wallet the default', async () => {
      expect(await service.setMode('u1', WalletMode.CASH)).toEqual({ ok: true });
      expect(users.update).toHaveBeenLastCalledWith('u1', {
        walletMode: WalletMode.CASH,
        defaultWallet: Wallet.CASH,
      });
      expect(await service.setMode('u1', WalletMode.DIGITAL)).toEqual({ ok: true });
      expect(users.update).toHaveBeenLastCalledWith('u1', {
        walletMode: WalletMode.DIGITAL,
        defaultWallet: Wallet.DIGITAL,
      });
    });

    it('refuses to turn off a wallet that has transactions', async () => {
      transactions.hasTransactionsInWallet.mockImplementation((_u, w) =>
        Promise.resolve(w === Wallet.DIGITAL),
      );
      expect(await service.setMode('u1', WalletMode.CASH)).toEqual({
        ok: false,
        blocked: Wallet.DIGITAL,
      });
      expect(users.update).not.toHaveBeenCalled();
    });

    it('refuses to turn off a wallet that has transfers', async () => {
      transfers.sumByWallet.mockResolvedValue({
        [Wallet.CASH]: { in: Money.zero(), out: Money.zero() },
        [Wallet.DIGITAL]: { in: Money.fromMajor(5), out: Money.zero() },
      });
      expect((await service.setMode('u1', WalletMode.CASH)).ok).toBe(false);
    });

    it('forgets a single-wallet default when going back to both, but keeps a real one', async () => {
      users.findById.mockResolvedValue(
        user({ walletMode: WalletMode.CASH, defaultWallet: Wallet.CASH }),
      );
      await service.setMode('u1', WalletMode.BOTH);
      expect(users.update).toHaveBeenLastCalledWith('u1', {
        walletMode: WalletMode.BOTH,
        defaultWallet: null,
      });

      users.findById.mockResolvedValue(
        user({ walletMode: WalletMode.BOTH, defaultWallet: Wallet.DIGITAL }),
      );
      await service.setMode('u1', WalletMode.BOTH);
      expect(users.update).toHaveBeenLastCalledWith('u1', {
        walletMode: WalletMode.BOTH,
        defaultWallet: Wallet.DIGITAL,
      });
    });

    it('throws for an unknown user', async () => {
      users.findById.mockResolvedValue(null);
      await expect(service.setMode('ghost', WalletMode.BOTH)).rejects.toThrow('not found');
    });
  });

  describe('opening balance', () => {
    const NOW = new Date('2026-10-12T03:00:00Z');

    it('is stored as an income entry in the Saldo Awal category through ONE atomic replace', async () => {
      await service.setOpeningBalance('u1', Wallet.CASH, Money.fromMajor(200000), NOW, 'm1');

      expect(transactions.replaceMarked).toHaveBeenCalledWith(
        'u1',
        Wallet.CASH,
        OPENING_BALANCE_NOTE,
        {
          userId: 'u1',
          categoryId: 'system-income-saldo-awal',
          type: TransactionType.INCOME,
          amount: Money.fromMajor(200000),
          description: 'Saldo awal',
          note: OPENING_BALANCE_NOTE,
          occurredAt: NOW,
          messageId: 'm1',
          wallet: Wallet.CASH,
        },
      );
    });

    it('still works before the category exists', async () => {
      categories.findByNameAndType.mockResolvedValue(null);
      await service.setOpeningBalance('u1', Wallet.DIGITAL, Money.fromMajor(1), NOW, null);
      expect(transactions.replaceMarked).toHaveBeenCalledWith(
        'u1',
        Wallet.DIGITAL,
        OPENING_BALANCE_NOTE,
        expect.objectContaining({ categoryId: null }),
      );
    });

    it('removes the entry when set to zero, without creating a new one', async () => {
      await service.setOpeningBalance('u1', Wallet.CASH, Money.zero(), NOW, 'm2');
      expect(transactions.replaceMarked).toHaveBeenCalledWith(
        'u1',
        Wallet.CASH,
        OPENING_BALANCE_NOTE,
        null,
      );
    });

    it('lists the wallets that still lack one (blank wallet counts as cash)', async () => {
      transactions.findByNote.mockResolvedValue([{ wallet: null }] as never);
      expect(await service.walletsWithoutOpening('u1', [Wallet.CASH, Wallet.DIGITAL])).toEqual([
        Wallet.DIGITAL,
      ]);
    });
  });

  describe('transfers', () => {
    const entity = (over: Partial<TransferEntity> = {}): TransferEntity => ({
      id: 't1',
      userId: 'u1',
      from: Wallet.DIGITAL,
      to: Wallet.CASH,
      amount: Money.fromMajor(100000),
      note: null,
      occurredAt: new Date(),
      messageId: 'm1',
      deletedAt: null,
      createdAt: new Date(),
      ...over,
    });

    it('reports period transfers and their totals in overview()', async () => {
      users.findById.mockResolvedValue(user({ defaultWallet: Wallet.CASH }));
      transfers.findManyInRange.mockResolvedValue([entity()]);
      transfers.sumByWallet.mockResolvedValue({
        [Wallet.CASH]: { in: Money.fromMajor(100000), out: Money.zero() },
        [Wallet.DIGITAL]: { in: Money.zero(), out: Money.fromMajor(100000) },
      });
      const o = await service.overview('u1', SummaryPeriod.Month, new Date(), 'Asia/Jakarta');
      expect(o.transfers).toHaveLength(1);
      expect(o.lines[0].transferIn.toNumber()).toBe(100000);
      expect(o.lines[1].transferOut.toNumber()).toBe(100000);
    });

    it('records a transfer once per chat message, scoped to the user', async () => {
      transfers.create.mockResolvedValue(entity());
      const now = new Date();
      expect(
        await service.transfer(
          'u1',
          Wallet.DIGITAL,
          Wallet.CASH,
          Money.fromMajor(100000),
          now,
          'm1',
        ),
      ).not.toBeNull();
      expect(transfers.existsByMessageId).toHaveBeenCalledWith('u1', 'm1');

      transfers.existsByMessageId.mockResolvedValue(true);
      expect(
        await service.transfer(
          'u1',
          Wallet.DIGITAL,
          Wallet.CASH,
          Money.fromMajor(100000),
          now,
          'm1',
        ),
      ).toBeNull();
      expect(transfers.create).toHaveBeenCalledTimes(1);
    });

    it('deletes the latest transfer for its owner, or returns null when there is none', async () => {
      transfers.findLatestForUser.mockResolvedValue(entity());
      expect((await service.deleteLastTransfer('u1'))?.id).toBe('t1');
      expect(transfers.softDelete).toHaveBeenCalledWith('u1', 't1');

      transfers.findLatestForUser.mockResolvedValue(null);
      expect(await service.deleteLastTransfer('u1')).toBeNull();
    });
  });

  it('sets the default wallet and clears settings on reset', async () => {
    await service.setDefault('u1', Wallet.DIGITAL);
    expect(users.update).toHaveBeenLastCalledWith('u1', { defaultWallet: Wallet.DIGITAL });
    await service.clearSettings('u1');
    expect(users.update).toHaveBeenLastCalledWith('u1', { defaultWallet: null });
  });
});
