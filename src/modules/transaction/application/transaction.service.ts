import { Injectable, Logger } from '@nestjs/common';
import { CategoryResolver } from 'src/modules/category/application/category-resolver.service';
import { CategoryEntity } from 'src/modules/category/domain/category.entity';
import { CategoryRepository } from 'src/modules/category/domain/category.repository';
import { AuditLogRepository } from 'src/modules/audit/domain/audit-log.repository';
import {
  RecordTransactionIntent,
  EditTransactionIntent,
} from 'src/modules/parser/domain/parsed-intent';
import { CreateTransactionInput, TransactionEntity } from '../domain/transaction.entity';
import { TransactionRepository } from '../domain/transaction.repository';

export interface TransactionResult {
  transaction: TransactionEntity;
  category: CategoryEntity | null;
}

/**
 * Application service for recording, editing and deleting transactions from
 * parsed intents. Resolves categories, persists via the repository port, and
 * writes an audit trail. Returns null on no-op / idempotent cases.
 */
@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    private readonly transactions: TransactionRepository,
    private readonly categories: CategoryRepository,
    private readonly categoryResolver: CategoryResolver,
    private readonly audit: AuditLogRepository,
  ) {}

  /** Record a new transaction. Returns null if this message was already recorded. */
  async record(
    userId: string,
    intent: RecordTransactionIntent,
    messageId: string | null,
  ): Promise<TransactionResult | null> {
    if (intent.amount === null) return null;

    if (messageId && (await this.transactions.existsByMessageId(userId, messageId))) {
      this.logger.debug({ messageId }, 'Transaction already recorded — skipping');
      return null;
    }

    const category = await this.categoryResolver.resolve(
      intent.keywords,
      intent.transactionType,
      userId,
    );

    const transaction = await this.transactions.create(
      await this.toCreateInput(userId, intent, category, messageId),
    );
    // null: a concurrent request already stored this message (the unique key caught it).
    if (!transaction) return null;

    await this.audit.record({
      userId,
      action: 'TX_CREATE',
      metadata: { transactionId: transaction.id, type: transaction.type },
    });

    return { transaction, category };
  }

  /**
   * Record several transactions from one message all-or-nothing. Item `i` uses the idempotency
   * key `<messageId>#<i>`, so re-processing the same message adds nothing. Returns only the rows
   * that were newly created.
   */
  async recordMany(
    userId: string,
    intents: RecordTransactionIntent[],
    messageId: string,
  ): Promise<TransactionResult[]> {
    const categories = await Promise.all(
      intents.map((intent) =>
        this.categoryResolver.resolve(intent.keywords, intent.transactionType, userId),
      ),
    );
    const inputs = await Promise.all(
      intents.map((intent, i) =>
        this.toCreateInput(userId, intent, categories[i], `${messageId}#${i}`),
      ),
    );
    const created = await this.transactions.createMany(inputs);

    const results: TransactionResult[] = [];
    created.forEach((transaction, i) => {
      if (transaction) results.push({ transaction, category: categories[i] });
    });
    for (const { transaction } of results) {
      await this.audit.record({
        userId,
        action: 'TX_CREATE',
        metadata: { transactionId: transaction.id, type: transaction.type },
      });
    }
    return results;
  }

  private toCreateInput(
    userId: string,
    intent: RecordTransactionIntent,
    category: CategoryEntity | null,
    messageId: string | null,
  ): Promise<CreateTransactionInput> {
    if (intent.amount === null) throw new Error('Cannot record a transaction without an amount');
    return Promise.resolve({
      userId,
      categoryId: category?.id ?? null,
      type: intent.transactionType,
      amount: intent.amount,
      description: intent.description || category?.name || 'Transaksi',
      occurredAt: intent.occurredAt,
      sourceMessage: intent.raw,
      messageId,
      wallet: intent.wallet,
    });
  }

  /** Edit the user's most recent transaction (amount and/or category). */
  async editLast(userId: string, intent: EditTransactionIntent): Promise<TransactionResult | null> {
    const latest = await this.transactions.findLatestForUser(userId);
    if (!latest) return null;

    let categoryId = latest.categoryId;
    let category: CategoryEntity | null = categoryId
      ? await this.categories.findById(categoryId, userId)
      : null;

    if (intent.keywords.length > 0) {
      const resolved = await this.categoryResolver.resolve(intent.keywords, latest.type, userId);
      if (resolved) {
        category = resolved;
        categoryId = resolved.id;
      }
    }

    const updated = await this.transactions.update(userId, latest.id, {
      ...(intent.amount !== null ? { amount: intent.amount } : {}),
      ...(categoryId !== latest.categoryId ? { categoryId } : {}),
      ...(intent.wallet ? { wallet: intent.wallet } : {}),
    });

    await this.audit.record({
      userId,
      action: 'TX_EDIT',
      metadata: { transactionId: updated.id },
    });

    return { transaction: updated, category };
  }

  /** The user's most recent transaction (with its category), without mutating. */
  async getLast(userId: string): Promise<TransactionResult | null> {
    const latest = await this.transactions.findLatestForUser(userId);
    if (!latest) return null;
    const category = latest.categoryId
      ? await this.categories.findById(latest.categoryId, userId)
      : null;
    return { transaction: latest, category };
  }

  /** Soft-delete the user's most recent transaction. */
  async deleteLast(userId: string): Promise<TransactionResult | null> {
    const latest = await this.transactions.findLatestForUser(userId);
    if (!latest) return null;

    await this.transactions.softDelete(userId, latest.id);
    await this.audit.record({
      userId,
      action: 'TX_DELETE',
      metadata: { transactionId: latest.id },
    });

    const category = latest.categoryId
      ? await this.categories.findById(latest.categoryId, userId)
      : null;
    return { transaction: latest, category };
  }
}
