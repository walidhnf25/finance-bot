import { CategoryResolver } from 'src/modules/category/application/category-resolver.service';
import { CategoryEntity } from 'src/modules/category/domain/category.entity';
import { CategoryRepository } from 'src/modules/category/domain/category.repository';
import { AuditLogRepository } from 'src/modules/audit/domain/audit-log.repository';
import {
  EditTransactionIntent,
  IntentType,
  RecordTransactionIntent,
} from 'src/modules/parser/domain/parsed-intent';
import { TransactionType } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';
import { TransactionEntity } from '../domain/transaction.entity';
import { TransactionRepository } from '../domain/transaction.repository';
import { TransactionService } from './transaction.service';

const foodCategory: CategoryEntity = {
  id: 'cat-food',
  userId: null,
  name: 'Makanan',
  type: TransactionType.EXPENSE,
  icon: '🍜',
  isSystem: true,
  createdAt: new Date(),
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
    occurredAt: new Date('2026-07-15T05:00:00.000Z'),
    sourceMessage: 'beli kopi 25rb',
    messageId: '1001:1',
    wallet: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function recordIntent(over: Partial<RecordTransactionIntent> = {}): RecordTransactionIntent {
  return {
    type: IntentType.RecordTransaction,
    raw: 'beli kopi 25rb',
    transactionType: TransactionType.EXPENSE,
    amount: Money.fromMajor(25000),
    description: 'kopi',
    keywords: ['kopi'],
    occurredAt: new Date('2026-07-15T05:00:00.000Z'),
    wallet: null,
    ...over,
  };
}

describe('TransactionService', () => {
  let transactions: jest.Mocked<TransactionRepository>;
  let categories: jest.Mocked<CategoryRepository>;
  let resolver: jest.Mocked<CategoryResolver>;
  let audit: jest.Mocked<AuditLogRepository>;
  let service: TransactionService;

  beforeEach(() => {
    transactions = {
      create: jest.fn(),
      createMany: jest.fn(),
      replaceMarked: jest.fn(),
      findById: jest.fn(),
      findLatestForUser: jest.fn(),
      findManyInRange: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      existsByMessageId: jest.fn(),
      sumByType: jest.fn(),
      sumByCategory: jest.fn(),
      sumByWallet: jest.fn(),
      hasExplicitWallet: jest.fn(),
      hasTransactionsInWallet: jest.fn(),
      findByNote: jest.fn(),
    };
    categories = { findById: jest.fn() } as unknown as jest.Mocked<CategoryRepository>;
    resolver = { resolve: jest.fn() } as unknown as jest.Mocked<CategoryResolver>;
    audit = { record: jest.fn() } as unknown as jest.Mocked<AuditLogRepository>;
    service = new TransactionService(transactions, categories, resolver, audit);
  });

  describe('record', () => {
    it('resolves category, persists and audits', async () => {
      transactions.existsByMessageId.mockResolvedValue(false);
      resolver.resolve.mockResolvedValue(foodCategory);
      transactions.create.mockResolvedValue(txEntity());

      const result = await service.record('u1', recordIntent(), '1001:1');

      expect(result?.category).toBe(foodCategory);
      expect(transactions.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', categoryId: 'cat-food', description: 'kopi' }),
      );
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'TX_CREATE' }));
    });

    it('is idempotent on a duplicate wa_message_id', async () => {
      transactions.existsByMessageId.mockResolvedValue(true);
      const result = await service.record('u1', recordIntent(), '1001:1');
      expect(result).toBeNull();
      expect(transactions.create).not.toHaveBeenCalled();
    });

    it('returns null when the amount is missing', async () => {
      const result = await service.record('u1', recordIntent({ amount: null }), 'wamid-x');
      expect(result).toBeNull();
    });
  });

  describe('deleteLast', () => {
    it('soft-deletes the latest transaction', async () => {
      transactions.findLatestForUser.mockResolvedValue(txEntity());
      categories.findById.mockResolvedValue(foodCategory);

      const result = await service.deleteLast('u1');
      expect(transactions.softDelete).toHaveBeenCalledWith('u1', 'tx1');
      expect(result?.transaction.id).toBe('tx1');
    });

    it('returns null when there is nothing to delete', async () => {
      transactions.findLatestForUser.mockResolvedValue(null);
      expect(await service.deleteLast('u1')).toBeNull();
    });
  });

  describe('editLast', () => {
    it('updates the amount of the latest transaction', async () => {
      transactions.findLatestForUser.mockResolvedValue(txEntity());
      categories.findById.mockResolvedValue(foodCategory);
      transactions.update.mockResolvedValue(txEntity({ amount: Money.fromMajor(30000) }));

      const intent: EditTransactionIntent = {
        type: IntentType.EditTransaction,
        raw: 'edit jadi 30rb',
        amount: Money.fromMajor(30000),
        keywords: [],
        wallet: null,
      };
      const result = await service.editLast('u1', intent);

      expect(transactions.update).toHaveBeenCalledWith(
        'u1',
        'tx1',
        expect.objectContaining({ amount: expect.any(Money) }),
      );
      expect(result?.transaction.amount.toNumber()).toBe(30000);
    });
  });
});
