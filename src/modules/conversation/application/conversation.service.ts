import { Injectable } from '@nestjs/common';
import { ConversationState } from 'src/shared/domain/enums';
import { ConversationContextEntity } from '../domain/conversation-context.entity';
import { ConversationRepository } from '../domain/conversation.repository';
import { PendingTransaction } from '../domain/pending-transaction';

/** How long a pending clarification stays valid before it expires. */
export const CONTEXT_TTL_MS = 5 * 60 * 1000;

/**
 * Domain-facing wrapper around the conversation context repository. Encapsulates
 * TTL handling and the small set of states the bot uses for multi-turn flows.
 */
@Injectable()
export class ConversationService {
  constructor(private readonly repository: ConversationRepository) {}

  /** Active (non-expired, non-IDLE) context, or null. */
  getActive(userId: string, now: Date): Promise<ConversationContextEntity | null> {
    return this.repository.getActive(userId, now);
  }

  /** Remember a transaction that is missing its amount and wait for the reply. */
  async awaitAmount(userId: string, pending: PendingTransaction, now: Date): Promise<void> {
    await this.repository.set({
      userId,
      state: ConversationState.AWAITING_AMOUNT,
      payload: pending as unknown as Record<string, unknown>,
      expiresAt: new Date(now.getTime() + CONTEXT_TTL_MS),
    });
  }

  /** Ask which wallets the user wants to use and wait for the answer. */
  async awaitWalletMode(userId: string, now: Date): Promise<void> {
    await this.repository.set({
      userId,
      state: ConversationState.AWAITING_WALLET_MODE,
      payload: null,
      expiresAt: new Date(now.getTime() + CONTEXT_TTL_MS),
    });
  }

  /** Ask for the opening balance of the first wallet in `queue`; the rest follow in order. */
  async awaitOpeningBalance(userId: string, queue: string[], now: Date): Promise<void> {
    await this.repository.set({
      userId,
      state: ConversationState.AWAITING_OPENING_BALANCE,
      payload: { queue },
      expiresAt: new Date(now.getTime() + CONTEXT_TTL_MS),
    });
  }

  /** Remember a complete transaction that still needs a wallet and wait for the reply. */
  async awaitWallet(userId: string, pending: PendingTransaction, now: Date): Promise<void> {
    await this.repository.set({
      userId,
      state: ConversationState.AWAITING_WALLET,
      payload: pending as unknown as Record<string, unknown>,
      expiresAt: new Date(now.getTime() + CONTEXT_TTL_MS),
    });
  }

  /**
   * Remember several complete transactions from one message that still need a wallet;
   * one answer covers all of them.
   */
  async awaitWalletBatch(
    userId: string,
    batch: PendingTransaction[],
    messageId: string,
    now: Date,
  ): Promise<void> {
    await this.repository.set({
      userId,
      state: ConversationState.AWAITING_WALLET,
      payload: { batch, messageId },
      expiresAt: new Date(now.getTime() + CONTEXT_TTL_MS),
    });
  }

  /** A receipt draft is waiting for the user's yes/no/correction; lives as long as the draft. */
  async awaitReceiptConfirm(userId: string, draftId: string, expiresAt: Date): Promise<void> {
    await this.repository.set({
      userId,
      state: ConversationState.AWAITING_RECEIPT_CONFIRM,
      payload: { draftId },
      expiresAt,
    });
  }

  /** Ask the user to confirm deleting their latest transaction (or transfer). */
  async awaitDeleteConfirm(userId: string, now: Date, target?: 'transfer'): Promise<void> {
    await this.repository.set({
      userId,
      state: ConversationState.AWAITING_DELETE_CONFIRM,
      payload: target ? { target } : null,
      expiresAt: new Date(now.getTime() + CONTEXT_TTL_MS),
    });
  }

  /** Ask the user to confirm wiping all of their data. */
  async awaitResetConfirm(userId: string, now: Date): Promise<void> {
    await this.repository.set({
      userId,
      state: ConversationState.AWAITING_CONFIRM,
      payload: { action: 'reset' },
      expiresAt: new Date(now.getTime() + CONTEXT_TTL_MS),
    });
  }

  clear(userId: string): Promise<void> {
    return this.repository.clear(userId);
  }
}
