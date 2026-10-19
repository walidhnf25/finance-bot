import { Money } from 'src/shared/utils/money';
import {
  CreateTransactionInput,
  TransactionEntity,
} from 'src/modules/transaction/domain/transaction.entity';

export type ReceiptStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';

export interface ReceiptDraftEntity {
  id: string;
  userId: string;
  status: ReceiptStatus;
  imageSha256: string;
  /** Stored extraction JSON; re-validated with `reviveExtraction` before use. */
  extraction: unknown;
  expiresAt: Date;
  transactionId: string | null;
  createdAt: Date;
}

export type CreateDraftResult =
  | { kind: 'created'; draft: ReceiptDraftEntity }
  /** The same image is already waiting for confirmation (re-sent photo). */
  | { kind: 'pending_exists'; draft: ReceiptDraftEntity }
  /** The same image was already turned into a transaction. */
  | { kind: 'already_confirmed' };

export type ConfirmResult =
  | { kind: 'confirmed'; transaction: TransactionEntity }
  /** A second confirmation of the same draft: no new transaction, the first one stands. */
  | { kind: 'already_confirmed' }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | { kind: 'not_found' };

/**
 * Persistence for receipt drafts. Every method takes the owning `userId` and filters on it in the
 * query itself, so a draft id alone never grants access.
 */
export abstract class ReceiptRepository {
  /** Insert a PENDING draft, or report the existing one for the same image (per user). */
  abstract createDraft(input: {
    userId: string;
    imageSha256: string;
    extraction: unknown;
    expiresAt: Date;
    now: Date;
  }): Promise<CreateDraftResult>;

  /** The user's unexpired PENDING draft for this exact image, if any (skips repeat OCR/AI work). */
  abstract findPendingByImage(
    userId: string,
    imageSha256: string,
    now: Date,
  ): Promise<ReceiptDraftEntity | null>;

  /** The user's newest PENDING, unexpired draft. */
  abstract findPending(userId: string, now: Date): Promise<ReceiptDraftEntity | null>;

  /** Replace the extraction of a PENDING draft (user correction). False when not pending. */
  abstract updateExtraction(
    userId: string,
    draftId: string,
    extraction: unknown,
    expiresAt: Date,
  ): Promise<boolean>;

  abstract cancel(userId: string, draftId: string): Promise<boolean>;

  /**
   * Whether the user already has a live (not deleted) EXPENSE of exactly this amount that happened in
   * [from, to). Used to warn about the same receipt photographed twice: two different image files of one
   * receipt have different hashes, so the image check cannot see it.
   */
  abstract hasExpenseLike(userId: string, amount: Money, from: Date, to: Date): Promise<boolean>;

  /** Drafts the user created since `since` (counts every status): the hourly limit input. */
  abstract countSince(userId: string, since: Date): Promise<number>;

  /**
   * Turn the draft into a transaction in ONE database transaction: the draft row is locked
   * (`SELECT ... FOR UPDATE`), re-checked (still PENDING, not expired), the transaction is inserted
   * with the idempotency key `receipt:<draftId>` and the draft is marked CONFIRMED. Two concurrent
   * confirmations therefore create exactly one transaction.
   */
  abstract confirm(
    userId: string,
    draftId: string,
    now: Date,
    build: (extraction: unknown) => Promise<CreateTransactionInput>,
  ): Promise<ConfirmResult>;
}
