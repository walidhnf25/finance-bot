import { TransactionType, Wallet } from 'src/shared/domain/enums';
import {
  CategoryTotal,
  CreateTransactionInput,
  DateRange,
  TransactionEntity,
  TypedTotals,
  UpdateTransactionInput,
} from './transaction.entity';

export interface FindManyOptions {
  type?: TransactionType;
  limit?: number;
}

/**
 * Persistence port for transactions. Every operation that touches a single row takes the owning
 * `userId` and filters by it in the query itself, so knowing a row's id never grants access to it.
 */
export abstract class TransactionRepository {
  /**
   * Insert one transaction. Returns null when the idempotency key (`messageId`) was already used
   * by this user: a retried or duplicated update can never create a second row.
   */
  abstract create(input: CreateTransactionInput): Promise<TransactionEntity | null>;

  /**
   * Insert several transactions all-or-nothing. The result has one entry per input, in order:
   * the new row, or null for an input whose idempotency key already existed.
   */
  abstract createMany(inputs: CreateTransactionInput[]): Promise<Array<TransactionEntity | null>>;

  abstract findById(userId: string, id: string): Promise<TransactionEntity | null>;

  /** Most recent non-deleted transaction for the user. */
  abstract findLatestForUser(userId: string): Promise<TransactionEntity | null>;

  abstract findManyInRange(
    userId: string,
    range: DateRange,
    options?: FindManyOptions,
  ): Promise<TransactionEntity[]>;

  /** Throws when the transaction does not exist, is deleted, or belongs to someone else. */
  abstract update(
    userId: string,
    id: string,
    patch: UpdateTransactionInput,
  ): Promise<TransactionEntity>;

  /** Throws when the transaction does not exist, is deleted, or belongs to someone else. */
  abstract softDelete(userId: string, id: string): Promise<void>;

  /** Idempotency guard: true if this user already used the key (deleted rows count). */
  abstract existsByMessageId(userId: string, messageId: string): Promise<boolean>;

  /** Total income and expense within the range (deleted excluded). */
  abstract sumByType(userId: string, range: DateRange): Promise<TypedTotals>;

  /**
   * Income/expense per wallet (deleted excluded); all time when no range is given.
   * Rows without a wallet count as CASH.
   */
  abstract sumByWallet(userId: string, range?: DateRange): Promise<Record<Wallet, TypedTotals>>;

  /** Non-deleted transactions of the user carrying the given note marker. */
  abstract findByNote(userId: string, note: string): Promise<TransactionEntity[]>;

  /**
   * Atomically replace a wallet's entry marked with `note`: soft-delete the existing ones and, when
   * `replacement` is given, insert it. Either both happen or neither.
   */
  abstract replaceMarked(
    userId: string,
    wallet: Wallet,
    note: string,
    replacement: CreateTransactionInput | null,
  ): Promise<TransactionEntity | null>;

  /** True when any non-deleted transaction sits in the wallet (blank counts as CASH). */
  abstract hasTransactionsInWallet(userId: string, wallet: Wallet): Promise<boolean>;

  /** True once the user has at least one transaction with an explicit wallet. */
  abstract hasExplicitWallet(userId: string): Promise<boolean>;

  /** Per-category totals for a given type within the range, optionally for one wallet. */
  abstract sumByCategory(
    userId: string,
    range: DateRange,
    type: TransactionType,
    wallet?: Wallet,
  ): Promise<CategoryTotal[]>;
}
