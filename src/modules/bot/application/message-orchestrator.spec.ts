import { BudgetService } from 'src/modules/budget/application/budget.service';
import { CategoryEntity } from 'src/modules/category/domain/category.entity';
import { ConversationService } from 'src/modules/conversation/application/conversation.service';
import { ConversationContextEntity } from 'src/modules/conversation/domain/conversation-context.entity';
import { IntentType } from 'src/modules/parser/domain/parsed-intent';
import { RuleBasedParser } from 'src/modules/parser/rule-based/rule-based.parser';
import { CsvExportService } from 'src/modules/report/application/csv-export.service';
import { ReportService } from 'src/modules/report/application/report.service';
import {
  TransactionResult,
  TransactionService,
} from 'src/modules/transaction/application/transaction.service';
import { ResetUserDataService } from 'src/modules/user/application/reset-user-data.service';
import { TransactionEntity } from 'src/modules/transaction/domain/transaction.entity';
import { UserEntity } from 'src/modules/user/domain/user.entity';
import {
  BudgetPeriod,
  ConversationState,
  TransactionType,
  Wallet,
  WalletMode,
} from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';
import { ReceiptService } from 'src/modules/receipt/application/receipt.service';
import { ReceiptExtraction } from 'src/modules/receipt/domain/receipt-extraction';
import { ResponseTooLargeError } from 'src/common/http/http';
import { IncomingMessage, MessagingGateway } from '../domain/messaging.gateway.port';
import { WalletService } from 'src/modules/wallet/application/wallet.service';
import { MessageOrchestrator } from './message-orchestrator';
import { ReplyBuilder } from './reply-builder';

const NOW = new Date('2026-07-15T03:00:00.000Z');

const user: UserEntity = {
  id: 'u1',
  telegramId: '628123',
  chatId: '628123',
  displayName: 'Budi',
  currency: 'IDR',
  timezone: 'Asia/Jakarta',
  isOnboarded: true,
  walletMode: null,
  defaultWallet: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const category: CategoryEntity = {
  id: 'cat-food',
  userId: null,
  name: 'Makanan',
  type: TransactionType.EXPENSE,
  icon: '🍜',
  isSystem: true,
  createdAt: NOW,
};

function txEntity(over: Partial<TransactionEntity> = {}): TransactionEntity {
  return {
    id: 'tx1',
    userId: 'u1',
    categoryId: 'cat-food',
    type: TransactionType.EXPENSE,
    amount: Money.fromMajor(25000),
    description: 'kopi',
    note: null,
    occurredAt: NOW,
    sourceMessage: '',
    messageId: 'w1',
    wallet: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const result: TransactionResult = { transaction: txEntity(), category };

function msg(text: string, id = 'w1'): IncomingMessage {
  return {
    messageId: id,
    from: '628123',
    chatId: '628123',
    text,
    timestamp: NOW,
  };
}

describe('MessageOrchestrator', () => {
  let conversation: jest.Mocked<ConversationService>;
  let transactions: jest.Mocked<TransactionService>;
  let budgets: jest.Mocked<BudgetService>;
  let reports: jest.Mocked<ReportService>;
  let csvExport: jest.Mocked<CsvExportService>;
  let wallets: jest.Mocked<WalletService>;
  let resetData: jest.Mocked<ResetUserDataService>;
  let receipts: jest.Mocked<ReceiptService>;
  let gateway: jest.Mocked<MessagingGateway>;
  let orchestrator: MessageOrchestrator;

  beforeEach(() => {
    conversation = {
      getActive: jest.fn().mockResolvedValue(null),
      awaitAmount: jest.fn().mockResolvedValue(undefined),
      awaitWallet: jest.fn().mockResolvedValue(undefined),
      awaitWalletBatch: jest.fn().mockResolvedValue(undefined),
      awaitWalletMode: jest.fn().mockResolvedValue(undefined),
      awaitOpeningBalance: jest.fn().mockResolvedValue(undefined),
      awaitDeleteConfirm: jest.fn().mockResolvedValue(undefined),
      awaitResetConfirm: jest.fn().mockResolvedValue(undefined),
      awaitReceiptConfirm: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConversationService>;
    transactions = {
      record: jest.fn(),
      recordMany: jest.fn(),
      editLast: jest.fn(),
      deleteLast: jest.fn(),
      getLast: jest.fn(),
    } as unknown as jest.Mocked<TransactionService>;
    budgets = {
      setBudget: jest.fn(),
      evaluate: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<BudgetService>;
    reports = { generateSummary: jest.fn() } as unknown as jest.Mocked<ReportService>;
    csvExport = { export: jest.fn() } as unknown as jest.Mocked<CsvExportService>;
    wallets = {
      overview: jest.fn().mockResolvedValue({
        mode: null,
        enabled: false,
        lines: [],
        total: Money.zero(),
        transfers: [],
      }),
      current: jest.fn().mockResolvedValue({
        mode: null,
        enabled: false,
        lines: [],
        total: Money.zero(),
        transfers: [],
      }),
      transfer: jest.fn(),
      getLastTransfer: jest.fn(),
      deleteLastTransfer: jest.fn(),
      setOpeningBalance: jest.fn(),
      setDefault: jest.fn(),
      // By default every wallet still lacks an opening balance.
      walletsWithoutOpening: jest
        .fn()
        .mockImplementation((_userId: string, list: Wallet[]) => Promise.resolve(list)),
      setMode: jest.fn(),
      clearSettings: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<WalletService>;
    resetData = {
      reset: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ResetUserDataService>;
    receipts = {
      exceedsSize: jest.fn().mockReturnValue(false),
      maxFileSizeBytes: 5 * 1_048_576,
      submit: jest.fn(),
      confirm: jest.fn(),
      cancel: jest.fn().mockResolvedValue(true),
      correct: jest.fn(),
      walletFor: jest.fn().mockReturnValue(Wallet.CASH),
    } as unknown as jest.Mocked<ReceiptService>;
    gateway = {
      downloadFile: jest.fn().mockResolvedValue(Buffer.from('img')),
    } as unknown as jest.Mocked<MessagingGateway>;
    orchestrator = new MessageOrchestrator(
      new RuleBasedParser(),
      conversation,
      transactions,
      budgets,
      reports,
      csvExport,
      resetData,
      wallets,
      new ReplyBuilder(),
      receipts,
      gateway,
    );
  });

  describe('record', () => {
    it('rejects an absurd amount before anything is stored or asked', async () => {
      const reply = await orchestrator.process(user, msg('beli mobil 99999999999999 juta'));
      expect(reply.text).toContain('terlalu besar');
      expect(transactions.record).not.toHaveBeenCalled();
      expect(transactions.recordMany).not.toHaveBeenCalled();
      expect(conversation.awaitWallet).not.toHaveBeenCalled();
    });

    it('records when the amount is present', async () => {
      transactions.record.mockResolvedValue(result);
      const reply = await orchestrator.process(user, msg('beli kopi 25rb'));
      expect(transactions.record).toHaveBeenCalled();
      expect(reply.text).toContain('Berhasil dicatat');
    });

    it('appends a budget alert when a threshold is crossed', async () => {
      transactions.record.mockResolvedValue(result);
      budgets.evaluate.mockResolvedValue([
        {
          categoryName: 'Makanan',
          period: 'MONTHLY' as never,
          used: Money.fromMajor(1_800_000),
          limit: Money.fromMajor(2_000_000),
          percent: 90,
          exceeded: false,
        },
      ]);
      const reply = await orchestrator.process(user, msg('beli kopi 25rb'));
      expect(reply.text).toContain('Budget');
      expect(reply.text).toContain('90%');
    });

    it('starts a clarification when the amount is missing', async () => {
      const reply = await orchestrator.process(user, msg('beli kopi'));
      expect(conversation.awaitAmount).toHaveBeenCalled();
      expect(reply.text).toContain('Berapa harga');
    });
  });

  describe('awaiting amount', () => {
    const context = {
      state: ConversationState.AWAITING_AMOUNT,
      payload: {
        transactionType: TransactionType.EXPENSE,
        description: 'kopi',
        keywords: ['kopi'],
        occurredAt: NOW.toISOString(),
      },
    } as unknown as ConversationContextEntity;

    it('completes the pending transaction from a bare amount', async () => {
      conversation.getActive.mockResolvedValue(context);
      transactions.record.mockResolvedValue(result);
      const reply = await orchestrator.process(user, msg('25 ribu', 'w2'));
      expect(transactions.record).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ description: 'kopi', keywords: ['kopi'] }),
        'w2',
      );
      expect(conversation.clear).toHaveBeenCalledWith('u1');
      expect(reply.text).toContain('Berhasil dicatat');
    });

    it('abandons the pending context on a topic change', async () => {
      conversation.getActive.mockResolvedValue(context);
      reports.generateSummary.mockResolvedValue({
        periodLabel: 'Bulan Ini',
        range: { start: NOW, end: NOW },
        income: Money.zero(),
        expense: Money.zero(),
        balance: Money.zero(),
        categories: [],
      });
      const reply = await orchestrator.process(user, msg('ringkasan bulan ini', 'w3'));
      expect(conversation.clear).toHaveBeenCalledWith('u1');
      expect(reply.text).toContain('Ringkasan');
    });
  });

  describe('summary / budget / export', () => {
    it('renders a summary', async () => {
      reports.generateSummary.mockResolvedValue({
        periodLabel: 'Bulan Ini',
        range: { start: NOW, end: NOW },
        income: Money.fromMajor(8_000_000),
        expense: Money.fromMajor(3_000_000),
        balance: Money.fromMajor(5_000_000),
        categories: [{ name: 'Makanan', icon: '🍜', total: Money.fromMajor(1_200_000) }],
      });
      const reply = await orchestrator.process(user, msg('ringkasan bulan ini'));
      expect(reply.text).toContain('Ringkasan Bulan Ini');
      expect(reply.text).toContain('Rp8.000.000');
      expect(reply.text).toContain('Makanan');
    });

    it('sets a budget', async () => {
      budgets.setBudget.mockResolvedValue({
        budget: { amount: Money.fromMajor(2_000_000), period: 'MONTHLY' } as never,
        category,
      });
      const reply = await orchestrator.process(user, msg('budget makan 2 juta'));
      expect(budgets.setBudget).toHaveBeenCalled();
      expect(reply.text).toContain('Budget diatur');
    });

    it('exports an Excel document', async () => {
      csvExport.export.mockResolvedValue({
        content: Buffer.from('x'),
        filename: 'transaksi-bulan-ini.xlsx',
        mimeType: 'application/vnd.ms-excel',
        rowCount: 3,
      });
      const reply = await orchestrator.process(user, msg('export bulan ini'));
      expect(reply.document?.filename).toBe('transaksi-bulan-ini.xlsx');
      expect(reply.text).toContain('3 transaksi');
    });
  });

  describe('wallets', () => {
    const recordedIntent = (): { wallet: Wallet | null } =>
      transactions.record.mock.calls[0][1] as unknown as { wallet: Wallet | null };

    it('leaves the wallet empty for a user without a default', async () => {
      transactions.record.mockResolvedValue(result);
      await orchestrator.process(user, msg('beli kopi 25rb'));
      expect(recordedIntent().wallet).toBeNull();
    });

    it('uses the default wallet when the message names none', async () => {
      transactions.record.mockResolvedValue(result);
      await orchestrator.process({ ...user, defaultWallet: Wallet.DIGITAL }, msg('beli kopi 25rb'));
      expect(recordedIntent().wallet).toBe(Wallet.DIGITAL);
    });

    it('prefers a wallet named in the message over the default', async () => {
      transactions.record.mockResolvedValue(result);
      await orchestrator.process(
        { ...user, defaultWallet: Wallet.DIGITAL },
        msg('beli kopi 25rb cash'),
      );
      expect(recordedIntent().wallet).toBe(Wallet.CASH);
    });

    it('keeps the wallet through the ask-for-amount flow', async () => {
      conversation.getActive.mockResolvedValue(null);
      await orchestrator.process(user, msg('beli kopi cash'));
      expect(conversation.awaitAmount).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ wallet: Wallet.CASH }),
        NOW,
      );
    });

    describe('asking for the wallet', () => {
      const enabledOverview = {
        mode: WalletMode.BOTH,
        enabled: true,
        lines: [],
        total: Money.zero(),
        transfers: [],
      };

      it('asks which wallet when the user uses wallets but has no default', async () => {
        wallets.current.mockResolvedValue(enabledOverview);
        const reply = await orchestrator.process(user, msg('beli cincau 5 ribu', 'w9'));

        expect(transactions.record).not.toHaveBeenCalled();
        expect(conversation.awaitWallet).toHaveBeenCalledWith(
          'u1',
          expect.objectContaining({ amount: '5000.00', description: 'cincau', messageId: 'w9' }),
          NOW,
        );
        expect(reply.text).toContain('cash');
        expect(reply.text).toContain('digital');
      });

      it('does not ask when the message names a wallet', async () => {
        wallets.current.mockResolvedValue(enabledOverview);
        transactions.record.mockResolvedValue(result);
        await orchestrator.process(user, msg('beli cincau 5 ribu cash'));
        expect(transactions.record).toHaveBeenCalled();
        expect(conversation.awaitWallet).not.toHaveBeenCalled();
      });

      it('does not ask when a default wallet is set', async () => {
        wallets.current.mockResolvedValue(enabledOverview);
        transactions.record.mockResolvedValue(result);
        await orchestrator.process(
          { ...user, defaultWallet: Wallet.DIGITAL },
          msg('beli cincau 5 ribu'),
        );
        expect(transactions.record).toHaveBeenCalled();
        expect(conversation.awaitWallet).not.toHaveBeenCalled();
      });

      it('does not ask users who never used wallets', async () => {
        transactions.record.mockResolvedValue(result);
        await orchestrator.process(user, msg('beli cincau 5 ribu'));
        expect(transactions.record).toHaveBeenCalled();
        expect(conversation.awaitWallet).not.toHaveBeenCalled();
      });

      const waiting = {
        state: ConversationState.AWAITING_WALLET,
        payload: {
          transactionType: TransactionType.EXPENSE,
          description: 'cincau',
          keywords: ['cincau'],
          occurredAt: NOW.toISOString(),
          wallet: null,
          amount: '5000.00',
          raw: 'beli cincau 5 ribu',
          messageId: 'w9',
        },
      } as unknown as ConversationContextEntity;

      it('records with the answered wallet, original amount and message id', async () => {
        conversation.getActive.mockResolvedValue(waiting);
        transactions.record.mockResolvedValue(result);
        const reply = await orchestrator.process(user, msg('digital', 'w10'));

        expect(transactions.record).toHaveBeenCalledWith(
          'u1',
          expect.objectContaining({ wallet: Wallet.DIGITAL, description: 'cincau' }),
          'w9',
        );
        const intent = transactions.record.mock.calls[0][1];
        expect(intent.amount?.toNumber()).toBe(5000);
        expect(conversation.clear).toHaveBeenCalledWith('u1');
        expect(reply.text).toContain('Berhasil dicatat');
      });

      it('asks again on an unclear answer and cancels on "batal"', async () => {
        conversation.getActive.mockResolvedValue(waiting);
        const retry = await orchestrator.process(user, msg('hmm', 'w11'));
        expect(retry.text).toContain('cash');
        expect(transactions.record).not.toHaveBeenCalled();

        const cancelled = await orchestrator.process(user, msg('batal', 'w12'));
        expect(cancelled.text).toContain('dibatalkan');
        expect(transactions.record).not.toHaveBeenCalled();
      });

      it('asks for the wallet after the amount arrives, without clearing the new question', async () => {
        wallets.current.mockResolvedValue(enabledOverview);
        conversation.getActive.mockResolvedValue({
          state: ConversationState.AWAITING_AMOUNT,
          payload: {
            transactionType: TransactionType.EXPENSE,
            description: 'kopi',
            keywords: ['kopi'],
            occurredAt: NOW.toISOString(),
          },
        } as unknown as ConversationContextEntity);

        await orchestrator.process(user, msg('25 ribu', 'w13'));

        const cleared = conversation.clear.mock.invocationCallOrder[0];
        const asked = conversation.awaitWallet.mock.invocationCallOrder[0];
        expect(cleared).toBeLessThan(asked);
      });
    });

    describe('wallet mode', () => {
      const cashOnly = { ...user, walletMode: WalletMode.CASH };

      it('always uses the only wallet and never asks', async () => {
        transactions.record.mockResolvedValue(result);
        await orchestrator.process(cashOnly, msg('beli kopi 25rb qris'));

        expect(transactions.record.mock.calls[0][1]).toEqual(
          expect.objectContaining({ wallet: Wallet.CASH }),
        );
        expect(conversation.awaitWallet).not.toHaveBeenCalled();
        expect(wallets.current).not.toHaveBeenCalled();
      });

      it('uses the digital wallet for a digital-only user', async () => {
        transactions.record.mockResolvedValue(result);
        await orchestrator.process(
          { ...user, walletMode: WalletMode.DIGITAL },
          msg('beli kopi 25rb'),
        );
        expect(transactions.record.mock.calls[0][1]).toEqual(
          expect.objectContaining({ wallet: Wallet.DIGITAL }),
        );
      });

      it('rejects features that need two wallets', async () => {
        const transfer = await orchestrator.process(cashOnly, msg('tarik tunai 500rb'));
        expect(transfer.text).toContain('Cash dan Digital');
        expect(wallets.transfer).not.toHaveBeenCalled();

        const opening = await orchestrator.process(cashOnly, msg('saldo awal digital 100rb'));
        expect(opening.text).toContain('tidak aktif');
        expect(wallets.setOpeningBalance).not.toHaveBeenCalled();

        const dflt = await orchestrator.process(cashOnly, msg('default digital'));
        expect(dflt.text).toContain('tidak perlu diatur');
        expect(wallets.setDefault).not.toHaveBeenCalled();
      });

      it('still accepts an opening balance for the active wallet', async () => {
        await orchestrator.process(cashOnly, msg('saldo awal cash 200rb'));
        expect(wallets.setOpeningBalance).toHaveBeenCalled();
      });

      it('ignores a wallet change when editing with one wallet', async () => {
        transactions.editLast.mockResolvedValue(result);
        await orchestrator.process(cashOnly, msg('edit ke digital'));
        expect(transactions.editLast.mock.calls[0][1]).toEqual(
          expect.objectContaining({ wallet: null }),
        );
      });

      it('asks without reading balances when the user explicitly chose both', async () => {
        await orchestrator.process(
          { ...user, walletMode: WalletMode.BOTH },
          msg('beli kopi 25rb', 'w30'),
        );
        expect(conversation.awaitWallet).toHaveBeenCalled();
        expect(wallets.current).not.toHaveBeenCalled();
      });

      it('starts the setup question on "atur dompet"', async () => {
        const reply = await orchestrator.process(user, msg('atur dompet'));
        expect(conversation.awaitWalletMode).toHaveBeenCalledWith('u1', NOW);
        expect(reply.text).toContain('Mau pakai dompet yang mana');
      });

      const asking = {
        state: ConversationState.AWAITING_WALLET_MODE,
        payload: null,
      } as unknown as ConversationContextEntity;

      it('applies the chosen mode', async () => {
        conversation.getActive.mockResolvedValue(asking);
        wallets.setMode.mockResolvedValue({ ok: true });
        const reply = await orchestrator.process(user, msg('3', 'w31'));

        expect(wallets.setMode).toHaveBeenCalledWith('u1', WalletMode.BOTH);
        expect(conversation.clear).toHaveBeenCalledWith('u1');
        expect(reply.text).toContain('Cash dan Digital');
      });

      it('asks the opening balance of each chosen wallet, cash first', async () => {
        conversation.getActive.mockResolvedValue(asking);
        wallets.setMode.mockResolvedValue({ ok: true });
        const reply = await orchestrator.process(user, msg('3', 'w40'));

        expect(conversation.awaitOpeningBalance).toHaveBeenCalledWith(
          'u1',
          [Wallet.CASH, Wallet.DIGITAL],
          NOW,
        );
        expect(reply.text).toContain('Cash dan Digital');
        expect(reply.text).toContain('Berapa saldo');
        expect(reply.text).toContain('Cash');
      });

      it('asks only for the chosen wallet in a one-wallet mode', async () => {
        conversation.getActive.mockResolvedValue(asking);
        wallets.setMode.mockResolvedValue({ ok: true });
        await orchestrator.process(user, msg('2', 'w41'));
        expect(conversation.awaitOpeningBalance).toHaveBeenCalledWith('u1', [Wallet.DIGITAL], NOW);
      });

      it('skips wallets that already have an opening balance', async () => {
        conversation.getActive.mockResolvedValue(asking);
        wallets.setMode.mockResolvedValue({ ok: true });
        wallets.walletsWithoutOpening.mockResolvedValue([Wallet.DIGITAL]); // cash already has one
        await orchestrator.process(user, msg('3', 'w42'));
        expect(wallets.walletsWithoutOpening).toHaveBeenCalledWith('u1', [
          Wallet.CASH,
          Wallet.DIGITAL,
        ]);
        expect(conversation.awaitOpeningBalance).toHaveBeenCalledWith('u1', [Wallet.DIGITAL], NOW);

        conversation.awaitOpeningBalance.mockClear();
        wallets.walletsWithoutOpening.mockResolvedValue([]); // both already have one
        const reply = await orchestrator.process(user, msg('3', 'w43'));
        expect(conversation.awaitOpeningBalance).not.toHaveBeenCalled();
        expect(reply.text).not.toContain('Berapa saldo');
      });

      it('does not ask for balances when the change is refused', async () => {
        conversation.getActive.mockResolvedValue(asking);
        wallets.setMode.mockResolvedValue({ ok: false, blocked: Wallet.CASH });
        await orchestrator.process(user, msg('2', 'w44'));
        expect(conversation.awaitOpeningBalance).not.toHaveBeenCalled();
      });

      it('explains a refused change', async () => {
        conversation.getActive.mockResolvedValue(asking);
        wallets.setMode.mockResolvedValue({ ok: false, blocked: Wallet.DIGITAL });
        const reply = await orchestrator.process(user, msg('cash saja', 'w32'));
        expect(reply.text).toContain('tidak bisa dinonaktifkan');
      });

      it('asks again on an unclear answer, and cancels on "batal"', async () => {
        conversation.getActive.mockResolvedValue(asking);
        const retry = await orchestrator.process(user, msg('hmm', 'w33'));
        expect(retry.text).toContain('Balas');
        const number = await orchestrator.process(user, msg('7', 'w34'));
        expect(number.text).toContain('Balas');
        expect(wallets.setMode).not.toHaveBeenCalled();

        const cancelled = await orchestrator.process(user, msg('batal', 'w35'));
        expect(cancelled.text).toContain('dibatalkan');
      });

      describe('opening balance questions', () => {
        const asked = (queue: Wallet[]) =>
          ({
            state: ConversationState.AWAITING_OPENING_BALANCE,
            payload: { queue },
          }) as unknown as ConversationContextEntity;

        it('stores the answer and moves on to the next wallet', async () => {
          conversation.getActive.mockResolvedValue(asked([Wallet.CASH, Wallet.DIGITAL]));
          const reply = await orchestrator.process(user, msg('200rb', 'w50'));

          expect(wallets.setOpeningBalance).toHaveBeenCalledWith(
            'u1',
            Wallet.CASH,
            expect.objectContaining({}),
            NOW,
            'w50',
          );
          expect(wallets.setOpeningBalance.mock.calls[0][2].toNumber()).toBe(200000);
          expect(conversation.awaitOpeningBalance).toHaveBeenCalledWith(
            'u1',
            [Wallet.DIGITAL],
            NOW,
          );
          expect(reply.text).toContain('Rp200.000');
          expect(reply.text).toContain('Digital');
          expect(reply.text).toContain('Berapa saldo');
        });

        it('finishes after the last wallet', async () => {
          conversation.getActive.mockResolvedValue(asked([Wallet.DIGITAL]));
          const reply = await orchestrator.process(user, msg('1 juta', 'w51'));

          expect(wallets.setOpeningBalance.mock.calls[0][1]).toBe(Wallet.DIGITAL);
          expect(wallets.setOpeningBalance.mock.calls[0][2].toNumber()).toBe(1000000);
          expect(conversation.clear).toHaveBeenCalledWith('u1');
          expect(conversation.awaitOpeningBalance).not.toHaveBeenCalled();
          expect(reply.text).toContain('Siap');
        });

        it('accepts zero as a real balance', async () => {
          conversation.getActive.mockResolvedValue(asked([Wallet.CASH]));
          await orchestrator.process(user, msg('0', 'w52'));
          expect(wallets.setOpeningBalance.mock.calls[0][2].toNumber()).toBe(0);
        });

        it.each(['lewati', 'nanti aja', 'belum ada'])(
          'skips a wallet on "%s" without storing anything',
          async (text) => {
            conversation.getActive.mockResolvedValue(asked([Wallet.CASH, Wallet.DIGITAL]));
            const reply = await orchestrator.process(user, msg(text, 'w53'));

            expect(wallets.setOpeningBalance).not.toHaveBeenCalled();
            expect(conversation.awaitOpeningBalance).toHaveBeenCalledWith(
              'u1',
              [Wallet.DIGITAL],
              NOW,
            );
            expect(reply.text).toContain('dilewati');
          },
        );

        it('asks again on an unclear answer and stops on "batal"', async () => {
          conversation.getActive.mockResolvedValue(asked([Wallet.CASH]));
          const retry = await orchestrator.process(user, msg('hmm', 'w54'));
          expect(retry.text).toContain('Balas nominal');
          expect(wallets.setOpeningBalance).not.toHaveBeenCalled();

          const stop = await orchestrator.process(user, msg('batal', 'w55'));
          expect(stop.text).toContain('dibatalkan');
          expect(conversation.clear).toHaveBeenCalledWith('u1');
        });

        it('drops the questions when the user does something else, not storing a stray amount', async () => {
          conversation.getActive.mockResolvedValue(asked([Wallet.CASH, Wallet.DIGITAL]));
          transactions.record.mockResolvedValue(result);
          const reply = await orchestrator.process(user, msg('beli kopi 25rb cash', 'w56'));

          expect(wallets.setOpeningBalance).not.toHaveBeenCalled();
          expect(transactions.record).toHaveBeenCalled();
          expect(reply.text).toContain('Berhasil dicatat');
        });
      });

      it('offers the setup question to a new user unless another question is pending', async () => {
        expect(await orchestrator.walletSetupPrompt(user, NOW)).toContain('Cash saja');
        expect(conversation.awaitWalletMode).toHaveBeenCalledWith('u1', NOW);

        conversation.awaitWalletMode.mockClear();
        conversation.getActive.mockResolvedValue(asking);
        expect(await orchestrator.walletSetupPrompt(user, NOW)).toBeNull();
        expect(conversation.awaitWalletMode).not.toHaveBeenCalled();
      });
    });

    it('answers help with a single message holding the whole menu', async () => {
      const reply = await orchestrator.process(user, msg('help'));
      expect(reply.text).toBe(new ReplyBuilder().compose({ type: IntentType.Help, raw: 'help' }));
      expect(Object.keys(reply)).toEqual(['text']);
    });

    describe('transfers', () => {
      const transferEntity = {
        id: 't1',
        userId: 'u1',
        from: Wallet.DIGITAL,
        to: Wallet.CASH,
        amount: Money.fromMajor(500000),
        note: null,
        occurredAt: NOW,
        messageId: 'w1',
        deletedAt: null,
        createdAt: NOW,
      };

      it('moves money from digital to cash on "tarik tunai"', async () => {
        wallets.transfer.mockResolvedValue(transferEntity);
        const reply = await orchestrator.process(user, msg('tarik tunai 500rb', 'w20'));

        expect(wallets.transfer).toHaveBeenCalledWith(
          'u1',
          Wallet.DIGITAL,
          Wallet.CASH,
          expect.objectContaining({}),
          NOW,
          'w20',
        );
        expect(wallets.transfer.mock.calls[0][3].toNumber()).toBe(500000);
        expect(reply.text).toContain('Transfer dicatat');
        expect(reply.text).toContain('Rp500.000');
      });

      it('sends nothing for an already-recorded message', async () => {
        wallets.transfer.mockResolvedValue(null);
        expect(await orchestrator.process(user, msg('tarik tunai 500rb'))).toEqual({});
      });

      it('asks for the amount or the direction when missing', async () => {
        const noAmount = await orchestrator.process(user, msg('tarik tunai'));
        expect(noAmount.text).toContain('nominal');
        const noDirection = await orchestrator.process(user, msg('pindah 300rb'));
        expect(noDirection.text).toContain('arah');
        expect(wallets.transfer).not.toHaveBeenCalled();
      });

      it('rejects a transfer to the same wallet', async () => {
        const reply = await orchestrator.process(user, msg('pindah 300rb dari cash ke cash'));
        expect(reply.text).toContain('tidak boleh sama');
        expect(wallets.transfer).not.toHaveBeenCalled();
      });

      it('confirms before deleting the latest transfer', async () => {
        wallets.getLastTransfer.mockResolvedValue(transferEntity);
        const ask = await orchestrator.process(user, msg('hapus transfer'));
        expect(conversation.awaitDeleteConfirm).toHaveBeenCalledWith('u1', NOW, 'transfer');
        expect(ask.text).toContain('Hapus transfer terakhir');

        conversation.getActive.mockResolvedValue({
          state: ConversationState.AWAITING_DELETE_CONFIRM,
          payload: { target: 'transfer' },
        } as unknown as ConversationContextEntity);
        wallets.deleteLastTransfer.mockResolvedValue(transferEntity);
        const done = await orchestrator.process(user, msg('ya', 'w21'));
        expect(wallets.deleteLastTransfer).toHaveBeenCalledWith('u1');
        expect(transactions.deleteLast).not.toHaveBeenCalled();
        expect(done.text).toContain('Transfer dihapus');
      });

      it('says so when there is no transfer to delete', async () => {
        wallets.getLastTransfer.mockResolvedValue(null);
        const reply = await orchestrator.process(user, msg('hapus transfer'));
        expect(reply.text).toContain('Belum ada transfer');
        expect(conversation.awaitDeleteConfirm).not.toHaveBeenCalled();
      });
    });

    it('shows balances for the balance command', async () => {
      wallets.current.mockResolvedValue({
        mode: WalletMode.BOTH,
        enabled: true,
        lines: [
          {
            wallet: Wallet.CASH,
            income: Money.zero(),
            expense: Money.zero(),
            balance: Money.fromMajor(400000),
            startBalance: Money.zero(),
            transferIn: Money.zero(),
            transferOut: Money.zero(),
            categories: [],
          },
          {
            wallet: Wallet.DIGITAL,
            income: Money.zero(),
            expense: Money.zero(),
            balance: Money.fromMajor(150000),
            startBalance: Money.zero(),
            transferIn: Money.zero(),
            transferOut: Money.zero(),
            categories: [],
          },
        ],
        total: Money.fromMajor(550000),
        transfers: [],
      });
      const reply = await orchestrator.process(user, msg('saldo'));
      expect(reply.text).toContain('Rp400.000');
      expect(reply.text).toContain('Rp150.000');
      expect(reply.text).toContain('Rp550.000');
    });

    it('sets the opening balance', async () => {
      const reply = await orchestrator.process(user, msg('saldo awal digital 1 juta', 'w60'));
      expect(wallets.setOpeningBalance).toHaveBeenCalledWith(
        'u1',
        Wallet.DIGITAL,
        expect.objectContaining({}),
        NOW,
        'w60',
      );
      expect(reply.text).toContain('Rp1.000.000');
      expect(reply.text).toContain('Pemasukan');
    });

    it('removes the opening balance when it is set to zero', async () => {
      const reply = await orchestrator.process(user, msg('saldo awal digital 0'));
      expect(wallets.setOpeningBalance.mock.calls[0][2].toNumber()).toBe(0);
      expect(reply.text).toContain('dihapus');
    });

    it('asks again when the opening balance is incomplete', async () => {
      const reply = await orchestrator.process(user, msg('saldo awal 200rb'));
      expect(wallets.setOpeningBalance).not.toHaveBeenCalled();
      expect(reply.text).toContain('saldo awal cash');
    });

    it('sets the default wallet', async () => {
      const reply = await orchestrator.process(user, msg('default digital'));
      expect(wallets.setDefault).toHaveBeenCalledWith('u1', Wallet.DIGITAL);
      expect(reply.text).toContain('default');
    });
  });

  describe('several transactions in one message', () => {
    const TWO = 'beli ayam 8 ribu, beli es teh manis 5 ribu';
    const ayam = () => ({
      transaction: txEntity({ description: 'ayam', amount: Money.fromMajor(8000) }),
      category,
    });
    const esTeh = () => ({
      transaction: txEntity({ description: 'es teh manis', amount: Money.fromMajor(5000) }),
      category,
    });
    /** The batch handed to TransactionService.recordMany on its `n`-th call. */
    const batch = (n = 0) => transactions.recordMany.mock.calls[n][1];
    const enabled = {
      mode: WalletMode.BOTH,
      enabled: true,
      lines: [],
      total: Money.zero(),
      transfers: [],
    };

    beforeEach(() => {
      transactions.recordMany.mockResolvedValue([ayam(), esTeh()]);
    });

    it('stores all items in ONE batch and answers once with the total', async () => {
      const reply = await orchestrator.process(user, msg(TWO, 'w1'));

      expect(transactions.recordMany).toHaveBeenCalledTimes(1);
      expect(transactions.record).not.toHaveBeenCalled();
      expect(transactions.recordMany.mock.calls[0][0]).toBe('u1');
      expect(batch().map((i) => i.amount?.toNumber())).toEqual([8000, 5000]);
      expect(batch().map((i) => i.description)).toEqual(['ayam', 'es teh manis']);
      expect(reply.text).toContain('2 transaksi dicatat');
      expect(reply.text).toContain('Rp13.000');
    });

    it('hands the original message id to the batch, which derives per-item keys', async () => {
      await orchestrator.process(user, msg(TWO, 'w1'));
      expect(transactions.recordMany.mock.calls[0][2]).toBe('w1');
    });

    it('sends nothing when every item was already recorded', async () => {
      transactions.recordMany.mockResolvedValue([]);
      expect(await orchestrator.process(user, msg(TWO, 'w1'))).toEqual({});
    });

    it('reports only the items that were new on a partial retry', async () => {
      transactions.recordMany.mockResolvedValue([esTeh()]);
      const reply = await orchestrator.process(user, msg(TWO, 'w1'));
      expect(reply.text).toContain('1 transaksi dicatat');
      expect(reply.text).not.toContain('ayam');
    });

    it('checks budgets after saving, showing the same alert a single time', async () => {
      const alert = {
        categoryName: 'Makanan',
        period: BudgetPeriod.MONTHLY,
        used: Money.fromMajor(90000),
        limit: Money.fromMajor(100000),
        percent: 90,
        exceeded: false,
      };
      budgets.evaluate.mockResolvedValue([alert]);

      const reply = await orchestrator.process(user, msg(TWO, 'w1'));

      expect(budgets.evaluate).toHaveBeenCalledTimes(2); // once per expense, after the batch
      expect(budgets.evaluate.mock.invocationCallOrder[0]).toBeGreaterThan(
        transactions.recordMany.mock.invocationCallOrder[0],
      );
      expect(reply.text?.match(/Budget/g)).toHaveLength(1);
    });

    it('does not check budgets for income', async () => {
      transactions.recordMany.mockResolvedValue([
        {
          transaction: txEntity({ type: TransactionType.INCOME, description: 'gaji' }),
          category,
        },
        esTeh(),
      ]);
      await orchestrator.process(user, msg('gaji 5 juta, beli es teh 5rb', 'w2'));
      expect(budgets.evaluate).toHaveBeenCalledTimes(1);
    });

    it('records with the wallet named once for all items', async () => {
      await orchestrator.process(user, msg('beli ayam 8rb, beli es teh 5rb cash', 'w3'));
      expect(batch().map((i) => i.wallet)).toEqual([Wallet.CASH, Wallet.CASH]);
    });

    it('uses the default wallet for every item without asking', async () => {
      await orchestrator.process({ ...user, defaultWallet: Wallet.DIGITAL }, msg(TWO, 'w4'));
      expect(batch().map((i) => i.wallet)).toEqual([Wallet.DIGITAL, Wallet.DIGITAL]);
      expect(conversation.awaitWalletBatch).not.toHaveBeenCalled();
    });

    it('forces the only wallet for a one-wallet user', async () => {
      await orchestrator.process(
        { ...user, walletMode: WalletMode.CASH },
        msg(TWO + ' qris', 'w5'),
      );
      expect(batch().map((i) => i.wallet)).toEqual([Wallet.CASH, Wallet.CASH]);
      expect(conversation.awaitWalletBatch).not.toHaveBeenCalled();
    });

    it('records silently for users who do not use wallets', async () => {
      await orchestrator.process(user, msg(TWO, 'w6'));
      expect(batch().map((i) => i.wallet)).toEqual([null, null]);
      expect(conversation.awaitWalletBatch).not.toHaveBeenCalled();
    });

    describe('asking for the wallet', () => {
      it('asks once for the whole batch and records nothing yet', async () => {
        wallets.current.mockResolvedValue(enabled);
        const reply = await orchestrator.process(user, msg(TWO, 'w7'));

        expect(transactions.recordMany).not.toHaveBeenCalled();
        expect(conversation.awaitWalletBatch).toHaveBeenCalledTimes(1);
        const [userId, pendingBatch, messageId] = conversation.awaitWalletBatch.mock.calls[0];
        expect(userId).toBe('u1');
        expect(messageId).toBe('w7');
        expect(pendingBatch.map((p) => [p.description, p.amount, p.wallet])).toEqual([
          ['ayam', '8000.00', null],
          ['es teh manis', '5000.00', null],
        ]);
        expect(reply.text).toContain('2 transaksi');
        expect(reply.text).toContain('cash');
      });

      it('only lists the items that still lack a wallet', async () => {
        wallets.current.mockResolvedValue(enabled);
        const reply = await orchestrator.process(
          user,
          msg('ayam 8rb cash, teh 5rb qris, roti 3rb', 'w8'),
        );
        expect(reply.text).toContain('1 transaksi');
        expect(reply.text).toContain('roti');
        expect(reply.text).not.toContain('ayam');
        expect(conversation.awaitWalletBatch.mock.calls[0][1]).toHaveLength(3);
      });

      const waiting = (items: unknown[]) =>
        ({
          state: ConversationState.AWAITING_WALLET,
          payload: { batch: items, messageId: 'w7' },
        }) as unknown as ConversationContextEntity;
      const pending = (description: string, amount: string, wallet: Wallet | null = null) => ({
        transactionType: TransactionType.EXPENSE,
        description,
        keywords: [description],
        occurredAt: NOW.toISOString(),
        wallet,
        amount,
        raw: description,
      });

      it('stores every item with the answered wallet under the original message id', async () => {
        conversation.getActive.mockResolvedValue(
          waiting([pending('ayam', '8000.00'), pending('es teh manis', '5000.00')]),
        );

        const reply = await orchestrator.process(user, msg('digital', 'w9'));

        expect(batch().map((i) => i.wallet)).toEqual([Wallet.DIGITAL, Wallet.DIGITAL]);
        expect(batch().map((i) => i.amount?.toNumber())).toEqual([8000, 5000]);
        expect(transactions.recordMany.mock.calls[0][2]).toBe('w7');
        expect(conversation.clear).toHaveBeenCalledWith('u1');
        expect(reply.text).toContain('2 transaksi dicatat');
      });

      it('keeps a wallet that an item named itself', async () => {
        conversation.getActive.mockResolvedValue(
          waiting([pending('ayam', '8000.00', Wallet.CASH), pending('roti', '3000.00')]),
        );
        await orchestrator.process(user, msg('digital', 'w10'));
        expect(batch().map((i) => i.wallet)).toEqual([Wallet.CASH, Wallet.DIGITAL]);
      });

      it('asks again on an unclear answer and cancels on "batal"', async () => {
        conversation.getActive.mockResolvedValue(waiting([pending('ayam', '8000.00')]));
        const retry = await orchestrator.process(user, msg('hmm', 'w11'));
        expect(retry.text).toContain('cash');
        expect(transactions.recordMany).not.toHaveBeenCalled();

        const cancelled = await orchestrator.process(user, msg('batal', 'w12'));
        expect(cancelled.text).toContain('dibatalkan');
        expect(transactions.recordMany).not.toHaveBeenCalled();
      });
    });

    it('accepts up to 15 items and refuses more, storing none', async () => {
      const many = (n: number) =>
        Array.from({ length: n }, (_, i) => `item${i + 1} 1rb`).join(', ');

      await orchestrator.process(user, msg(many(15), 'w13'));
      expect(batch()).toHaveLength(15);

      transactions.recordMany.mockClear();
      const reply = await orchestrator.process(user, msg(many(16), 'w14'));
      expect(reply.text).toContain('15');
      expect(transactions.recordMany).not.toHaveBeenCalled();
    });

    it('still records a single transaction the old way', async () => {
      transactions.record.mockResolvedValue(result);
      const reply = await orchestrator.process(user, msg('beli kopi 25rb', 'w15'));
      expect(transactions.record.mock.calls[0][2]).toBe('w15'); // no "#0" suffix
      expect(transactions.recordMany).not.toHaveBeenCalled();
      expect(reply.text).toContain('Berhasil dicatat');
    });

    it('drops a pending question when a batch arrives', async () => {
      conversation.getActive.mockResolvedValue({
        state: ConversationState.AWAITING_AMOUNT,
        payload: {
          transactionType: TransactionType.EXPENSE,
          description: 'kopi',
          keywords: ['kopi'],
          occurredAt: NOW.toISOString(),
        },
      } as unknown as ConversationContextEntity);

      const reply = await orchestrator.process(user, msg(TWO, 'w16'));
      expect(conversation.clear).toHaveBeenCalledWith('u1');
      expect(reply.text).toContain('2 transaksi dicatat');
    });
  });

  describe('delete with confirmation', () => {
    it('asks to confirm then deletes on "ya"', async () => {
      transactions.getLast.mockResolvedValue(result);
      const prompt = await orchestrator.process(user, msg('hapus'));
      expect(conversation.awaitDeleteConfirm).toHaveBeenCalled();
      expect(prompt.text).toContain('Hapus transaksi terakhir?');

      conversation.getActive.mockResolvedValue({
        state: ConversationState.AWAITING_DELETE_CONFIRM,
        payload: null,
      } as unknown as ConversationContextEntity);
      transactions.deleteLast.mockResolvedValue(result);
      const done = await orchestrator.process(user, msg('ya', 'w4'));
      expect(transactions.deleteLast).toHaveBeenCalledWith('u1');
      expect(done.text).toContain('dihapus');
    });

    it('cancels on "tidak"', async () => {
      conversation.getActive.mockResolvedValue({
        state: ConversationState.AWAITING_DELETE_CONFIRM,
        payload: null,
      } as unknown as ConversationContextEntity);
      const reply = await orchestrator.process(user, msg('tidak', 'w5'));
      expect(transactions.deleteLast).not.toHaveBeenCalled();
      expect(reply.text).toContain('dibatalkan');
    });
  });

  describe('reset data', () => {
    it('asks to confirm on "reset"', async () => {
      const reply = await orchestrator.process(user, msg('reset'));
      expect(conversation.awaitResetConfirm).toHaveBeenCalledWith('u1', NOW);
      expect(reply.text).toContain('reset SEMUA data');
      expect(resetData.reset).not.toHaveBeenCalled();
    });

    it('wipes data on "ya" while awaiting reset confirm', async () => {
      conversation.getActive.mockResolvedValue({
        state: ConversationState.AWAITING_CONFIRM,
        payload: { action: 'reset' },
      } as unknown as ConversationContextEntity);
      const reply = await orchestrator.process(user, msg('ya', 'wr'));
      expect(resetData.reset).toHaveBeenCalledWith('u1');
      expect(conversation.clear).toHaveBeenCalledWith('u1');
      expect(reply.text).toContain('direset');
    });

    it('cancels reset on "tidak"', async () => {
      conversation.getActive.mockResolvedValue({
        state: ConversationState.AWAITING_CONFIRM,
        payload: { action: 'reset' },
      } as unknown as ConversationContextEntity);
      const reply = await orchestrator.process(user, msg('tidak', 'wr2'));
      expect(resetData.reset).not.toHaveBeenCalled();
      expect(reply.text).toContain('dibatalkan');
    });
  });

  describe('receipt photo', () => {
    const extraction: ReceiptExtraction = {
      merchant: 'Toko *Aman*_',
      date: '2026-07-14',
      total: 45000,
      items: [],
      categoryHint: null,
      wallet: null,
      warnings: ['TOTAL_NOT_IN_TEXT'],
    };
    const draft = { id: 'd1', expiresAt: new Date(NOW.getTime() + 1_800_000) };
    const photo = (id = 'p1'): IncomingMessage => ({
      ...msg('', id),
      attachment: { kind: 'image', fileId: 'f1', sizeBytes: 1000 },
    });

    it('creates a draft, asks for confirmation and records NOTHING', async () => {
      receipts.submit.mockResolvedValue({
        kind: 'draft',
        draft,
        extraction,
        method: 'model',
      } as never);
      const reply = await orchestrator.process(user, photo());

      expect(gateway.downloadFile).toHaveBeenCalledWith('f1', 5 * 1_048_576);
      expect(conversation.awaitReceiptConfirm).toHaveBeenCalledWith('u1', 'd1', draft.expiresAt);
      expect(transactions.record).not.toHaveBeenCalled();
      expect(transactions.recordMany).not.toHaveBeenCalled();
      expect(reply.text).toContain('Rp45.000');
      expect(reply.text).toContain('Balas *ya*');
      // Markdown characters from the photo are neutralised; the warning is shown.
      expect(reply.text).toContain('Toko Aman');
      expect(reply.text).not.toContain('*Aman*');
      expect(reply.text).toContain('tidak terlihat jelas');
    });

    it('rejects an oversized announced file without downloading it', async () => {
      receipts.exceedsSize.mockReturnValue(true);
      const reply = await orchestrator.process(user, photo());
      expect(gateway.downloadFile).not.toHaveBeenCalled();
      expect(receipts.submit).not.toHaveBeenCalled();
      expect(reply.text).toContain('terlalu besar');
    });

    it('answers politely when the download turns out larger than the limit', async () => {
      gateway.downloadFile.mockRejectedValue(new ResponseTooLargeError(5));
      const reply = await orchestrator.process(user, photo());
      expect(reply.text).toContain('terlalu besar');
    });

    it('lets a transient download failure propagate so the update is retried', async () => {
      gateway.downloadFile.mockRejectedValue(new Error('network'));
      await expect(orchestrator.process(user, photo())).rejects.toThrow('network');
    });

    it.each([
      [{ kind: 'unreadable' }, 'belum bisa membaca'],
      [{ kind: 'rate_limited' }, 'Terlalu banyak foto'],
      [{ kind: 'already_confirmed' }, 'sudah tercatat'],
      [{ kind: 'rejected_image', reason: 'unsupported' }, 'JPG, PNG, atau WebP'],
    ])('replies for %j', async (submitResult, expected) => {
      receipts.submit.mockResolvedValue(submitResult as never);
      const reply = await orchestrator.process(user, photo());
      expect(reply.text).toContain(expected);
      expect(conversation.awaitReceiptConfirm).not.toHaveBeenCalled();
    });

    describe('while a draft awaits confirmation', () => {
      beforeEach(() => {
        conversation.getActive.mockResolvedValue({
          state: ConversationState.AWAITING_RECEIPT_CONFIRM,
          payload: { draftId: 'd1' },
        } as unknown as ConversationContextEntity);
      });

      it('"ya" confirms and reports the recorded transaction', async () => {
        receipts.confirm.mockResolvedValue({
          kind: 'confirmed',
          transaction: txEntity({ amount: Money.fromMajor(45000), description: 'Toko' }),
          category,
        });
        const reply = await orchestrator.process(user, msg('ya', 'c1'));
        expect(receipts.confirm).toHaveBeenCalledWith(user, NOW);
        expect(conversation.clear).toHaveBeenCalledWith('u1');
        expect(reply.text).toContain('Dari struk');
        expect(reply.text).toContain('Berhasil dicatat');
      });

      it('"batal" cancels the draft and records nothing', async () => {
        const reply = await orchestrator.process(user, msg('batal', 'c2'));
        expect(receipts.cancel).toHaveBeenCalled();
        expect(receipts.confirm).not.toHaveBeenCalled();
        expect(reply.text).toContain('dibatalkan');
      });

      it('a correction updates the draft and asks again instead of recording', async () => {
        receipts.correct.mockResolvedValue({
          draft,
          extraction: { ...extraction, total: 52000, warnings: [] },
        } as never);
        const reply = await orchestrator.process(user, msg('total 52rb ya', 'c3'));
        expect(receipts.correct).toHaveBeenCalledWith(
          user,
          expect.objectContaining({ total: 52000 }),
          NOW,
        );
        expect(receipts.confirm).not.toHaveBeenCalled();
        expect(reply.text).toContain('Rp52.000');
      });

      it('tells the user when a confirmation finds the draft expired or already used', async () => {
        receipts.confirm.mockResolvedValue({ kind: 'expired' });
        expect((await orchestrator.process(user, msg('ya', 'c4'))).text).toContain('kedaluwarsa');
        receipts.confirm.mockResolvedValue({ kind: 'already_confirmed' });
        expect((await orchestrator.process(user, msg('ya', 'c5'))).text).toContain(
          'tidak dicatat dua kali',
        );
      });

      it('gibberish gets a reminder, not a recording', async () => {
        const reply = await orchestrator.process(user, msg('hmmmm', 'c6'));
        expect(reply.text).toContain('Balas *ya*');
        expect(receipts.confirm).not.toHaveBeenCalled();
      });
    });
  });
});
