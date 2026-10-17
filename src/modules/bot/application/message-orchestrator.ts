import { Injectable, Optional } from '@nestjs/common';
import { ResponseTooLargeError } from 'src/common/http/http';
import { BudgetService } from 'src/modules/budget/application/budget.service';
import { BudgetAlert } from 'src/modules/budget/domain/budget-alert';
import { ConversationService } from 'src/modules/conversation/application/conversation.service';
import { ConversationContextEntity } from 'src/modules/conversation/domain/conversation-context.entity';
import { PendingTransaction } from 'src/modules/conversation/domain/pending-transaction';
import { MessageParser } from 'src/modules/parser/domain/message-parser.port';
import {
  IntentType,
  ParsedIntent,
  RecordTransactionIntent,
} from 'src/modules/parser/domain/parsed-intent';
import { ReceiptService } from 'src/modules/receipt/application/receipt.service';
import { parseReceiptCorrection } from 'src/modules/receipt/domain/receipt-correction';
import { CsvExportService } from 'src/modules/report/application/csv-export.service';
import { ReportService } from 'src/modules/report/application/report.service';
import {
  TransactionResult,
  TransactionService,
} from 'src/modules/transaction/application/transaction.service';
import { ResetUserDataService } from 'src/modules/user/application/reset-user-data.service';
import { UserEntity } from 'src/modules/user/domain/user.entity';
import { WalletService } from 'src/modules/wallet/application/wallet.service';
import {
  activeWallets,
  ConversationState,
  TransactionType,
  Wallet,
  WalletMode,
} from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';
import { tokenize } from 'src/shared/utils/string-normalizer';
import { IncomingMessage, MessagingGateway } from '../domain/messaging.gateway.port';
import { ReceiptJobProducer } from './receipt-job.producer';
import { ReplyBuilder } from './reply-builder';
import { interpretYesNo } from './yes-no';

/** Most transactions accepted in one message. */
const MAX_BATCH_ITEMS = 15;

/** Answers that skip an opening-balance question. */
const OPENING_SKIP_WORDS = [
  'lewati',
  'skip',
  'nanti',
  'belum',
  'tidak',
  'ga',
  'gak',
  'nggak',
  'engga',
  'enggak',
  'kosong',
];

/** A reply to send back: text and/or a document (Excel export). Empty = send nothing. */
export interface OutgoingReply {
  text?: string;
  document?: { content: Buffer; filename: string; mimeType: string };
}

/**
 * Stateful entry point for inbound messages: consults the conversation context
 * to continue a multi-turn flow, otherwise routes the parsed intent to the
 * relevant application service and produces the reply.
 */
@Injectable()
export class MessageOrchestrator {
  constructor(
    private readonly parser: MessageParser,
    private readonly conversation: ConversationService,
    private readonly transactions: TransactionService,
    private readonly budgets: BudgetService,
    private readonly reports: ReportService,
    private readonly csvExport: CsvExportService,
    private readonly resetData: ResetUserDataService,
    private readonly wallets: WalletService,
    private readonly replies: ReplyBuilder,
    private readonly receipts: ReceiptService,
    private readonly gateway: MessagingGateway,
    @Optional() private readonly receiptJobs?: ReceiptJobProducer,
  ) {}

  async process(user: UserEntity, message: IncomingMessage): Promise<OutgoingReply> {
    const now = message.timestamp;
    if (message.attachment) return this.receiptPhoto(user, message);

    const context = await this.conversation.getActive(user.id, now);
    const intent = await this.parser.parse({ text: message.text, now, timezone: user.timezone });

    // Reject absurd amounts up front, before anything is stored (the database would refuse them
    // too, but with an unhelpful error).
    if (this.amountsIn(intent).some((amount) => !amount.isWithinLimit() && !amount.isZero())) {
      return { text: this.replies.amountTooLarge() };
    }

    if (context) {
      const continued = await this.continue(user, context, intent, message);
      if (continued !== null) return continued;
      await this.conversation.clear(user.id);
    }

    return this.routeFresh(user, intent, message);
  }

  private async continue(
    user: UserEntity,
    context: ConversationContextEntity,
    intent: ParsedIntent,
    message: IncomingMessage,
  ): Promise<OutgoingReply | null> {
    if (context.state === ConversationState.AWAITING_AMOUNT) {
      if (intent.type === IntentType.AmountOnly) {
        // Clear first: finishing the transaction may open a new follow-up (wallet question).
        await this.conversation.clear(user.id);
        return this.completePending(user, context.payload, intent.amount, message);
      }
      if (intent.type === IntentType.Unknown || intent.type === IntentType.Greeting) {
        return { text: this.replies.askAmount() };
      }
      return null;
    }

    if (context.state === ConversationState.AWAITING_WALLET_MODE) {
      const mode = this.parser.parseWalletMode(message.text);
      if (mode !== null) {
        await this.conversation.clear(user.id);
        const result = await this.wallets.setMode(user.id, mode);
        if (!result.ok) return { text: this.replies.walletModeBlocked(result.blocked) };

        // Then ask for the balance of each chosen wallet that has none yet.
        const queue = await this.wallets.walletsWithoutOpening(user.id, activeWallets(mode));
        if (queue.length === 0) return { text: this.replies.walletModeSet(mode) };
        await this.conversation.awaitOpeningBalance(user.id, queue, message.timestamp);
        return {
          text: `${this.replies.walletModeSet(mode)}\n\n${this.replies.askOpeningBalanceFor(queue[0])}`,
        };
      }
      if (this.yesNo(message.text) === 'no') {
        await this.conversation.clear(user.id);
        return { text: this.replies.cancelled() };
      }
      if (
        intent.type === IntentType.Unknown ||
        intent.type === IntentType.Greeting ||
        intent.type === IntentType.AmountOnly
      ) {
        return { text: this.replies.walletModeRetry() };
      }
      return null;
    }

    if (context.state === ConversationState.AWAITING_OPENING_BALANCE) {
      const [current, ...rest] = (context.payload as { queue?: Wallet[] } | null)?.queue ?? [];
      if (!current) return null;

      const tokens = new Set(tokenize(message.text));
      if (tokens.has('batal')) {
        await this.conversation.clear(user.id);
        return { text: this.replies.cancelled() };
      }

      let amount: Money | null = null;
      let answered = false;
      if (intent.type === IntentType.AmountOnly) {
        amount = intent.amount;
        answered = true;
      } else if (tokens.has('nol') || /(^|\s)(rp\.?\s*)?0(\s|$)/i.test(message.text)) {
        amount = Money.zero();
        answered = true;
      } else if (OPENING_SKIP_WORDS.some((w) => tokens.has(w))) {
        answered = true; // skipped: leave the balance unset
      }

      if (!answered) {
        if (intent.type === IntentType.Unknown || intent.type === IntentType.Greeting) {
          return { text: this.replies.openingBalanceRetry(current) };
        }
        return null; // something else entirely: drop the questions
      }

      if (amount !== null) {
        await this.wallets.setOpeningBalance(
          user.id,
          current,
          amount,
          message.timestamp,
          message.messageId,
        );
      }
      const ack = this.replies.openingBalanceAck(current, amount);
      if (rest.length > 0) {
        await this.conversation.awaitOpeningBalance(user.id, rest, message.timestamp);
        return { text: `${ack}\n\n${this.replies.askOpeningBalanceFor(rest[0])}` };
      }
      await this.conversation.clear(user.id);
      return { text: `${ack}\n\n${this.replies.openingBalanceDone()}` };
    }

    if (context.state === ConversationState.AWAITING_WALLET) {
      const batchPayload = context.payload as {
        batch?: PendingTransaction[];
        messageId?: string;
      } | null;
      if (batchPayload?.batch?.length) {
        const answer = this.parser.parseWallet(message.text);
        if (answer !== null) {
          await this.conversation.clear(user.id);
          return this.recordBatch(
            user,
            batchPayload.batch.map((p) => this.pendingToIntent(p, p.wallet ?? answer)),
            batchPayload.messageId ?? message.messageId,
            message.timestamp,
          );
        }
        if (this.yesNo(message.text) === 'no') {
          await this.conversation.clear(user.id);
          return { text: this.replies.cancelled() };
        }
        if (intent.type === IntentType.Unknown || intent.type === IntentType.Greeting) {
          return { text: this.replies.askWalletRetry() };
        }
        return null;
      }

      const pending = context.payload as unknown as PendingTransaction | null;
      if (!pending?.amount) return null;

      const wallet = this.parser.parseWallet(message.text);
      if (wallet !== null) {
        const intent: RecordTransactionIntent = {
          type: IntentType.RecordTransaction,
          raw: pending.raw ?? message.text,
          transactionType: pending.transactionType,
          amount: Money.fromMajor(pending.amount),
          description: pending.description,
          keywords: pending.keywords,
          occurredAt: new Date(pending.occurredAt),
          wallet,
        };
        await this.conversation.clear(user.id);
        return this.recordAndReply(
          user,
          intent,
          pending.messageId ?? message.messageId,
          message.timestamp,
        );
      }
      if (this.yesNo(message.text) === 'no') {
        await this.conversation.clear(user.id);
        return { text: this.replies.cancelled() };
      }
      if (intent.type === IntentType.Unknown || intent.type === IntentType.Greeting) {
        return { text: this.replies.askWalletRetry() };
      }
      return null;
    }

    if (context.state === ConversationState.AWAITING_RECEIPT_CONFIRM) {
      // A correction wins over a stray "ya" in the same message: show the result before recording.
      const correction = parseReceiptCorrection(
        message.text,
        message.timestamp,
        user.timezone,
        (text) => this.parser.parseWallet(text),
      );
      if (correction) {
        const updated = await this.receipts.correct(user, correction, message.timestamp);
        if (!updated) return { text: this.replies.receiptCorrectionRejected() };
        await this.conversation.awaitReceiptConfirm(
          user.id,
          updated.draft.id,
          updated.draft.expiresAt,
        );
        return {
          text: this.replies.receiptPreview(
            updated.extraction,
            this.receipts.walletFor(user, updated.extraction),
            user.timezone,
          ),
        };
      }
      const answer = this.yesNo(message.text);
      if (answer === 'yes') return this.confirmReceipt(user, message);
      if (answer === 'no') {
        await this.receipts.cancel(user, message.timestamp);
        await this.conversation.clear(user.id);
        return { text: this.replies.cancelled() };
      }
      if (intent.type === IntentType.Unknown || intent.type === IntentType.Greeting) {
        return { text: this.replies.receiptRetry() };
      }
      return null; // something else entirely: the draft simply stays until it expires
    }

    if (context.state === ConversationState.AWAITING_DELETE_CONFIRM) {
      const answer = this.yesNo(message.text);
      if (answer === 'yes') {
        if ((context.payload as { target?: string } | null)?.target === 'transfer') {
          const removed = await this.wallets.deleteLastTransfer(user.id);
          await this.conversation.clear(user.id);
          return {
            text: removed
              ? this.replies.transferDeleted(removed)
              : this.replies.nothingToDeleteTransfer(),
          };
        }
        const deleted = await this.transactions.deleteLast(user.id);
        await this.conversation.clear(user.id);
        return {
          text: deleted ? this.replies.deleted(deleted) : this.replies.nothingToDelete(),
        };
      }
      if (answer === 'no') {
        await this.conversation.clear(user.id);
        return { text: this.replies.cancelled() };
      }
      if (intent.type === IntentType.Unknown || intent.type === IntentType.Greeting) {
        return { text: this.replies.deleteConfirmRetry() };
      }
      return null;
    }

    if (context.state === ConversationState.AWAITING_CONFIRM) {
      const action = (context.payload as { action?: string } | null)?.action;
      if (action !== 'reset') return null;

      const answer = this.yesNo(message.text);
      if (answer === 'yes') {
        await this.resetData.reset(user.id);
        await this.wallets.clearSettings(user.id);
        await this.conversation.clear(user.id);
        return { text: this.replies.dataReset() };
      }
      if (answer === 'no') {
        await this.conversation.clear(user.id);
        return { text: this.replies.cancelled() };
      }
      if (intent.type === IntentType.Unknown || intent.type === IntentType.Greeting) {
        return { text: this.replies.resetConfirmRetry() };
      }
      return null;
    }

    return null;
  }

  /**
   * A photo never records anything: it creates a draft that the user must confirm. With a background queue
   * configured the reading happens there (retried, survives a restart); otherwise, or when the queue is
   * unreachable, it happens right here.
   */
  private async receiptPhoto(user: UserEntity, message: IncomingMessage): Promise<OutgoingReply> {
    const attachment = message.attachment;
    if (!attachment) return {};
    // cheap refusals first: an oversized photo never takes a queue slot
    if (this.receipts.exceedsSize(attachment.sizeBytes)) {
      return {
        text: this.replies.receiptTooLarge(Math.floor(this.receipts.maxFileSizeBytes / 1_048_576)),
      };
    }
    const queued = await this.receiptJobs?.tryEnqueue(user, message);
    if (queued) return { text: this.replies.receiptQueued() };
    return this.readReceipt(user, message);
  }

  /** Download, read and draft one receipt photo, and return the reply (also run by the queue worker). */
  async readReceipt(user: UserEntity, message: IncomingMessage): Promise<OutgoingReply> {
    const attachment = message.attachment;
    if (!attachment) return {};
    const limitMb = Math.floor(this.receipts.maxFileSizeBytes / 1_048_576);
    if (this.receipts.exceedsSize(attachment.sizeBytes)) {
      return { text: this.replies.receiptTooLarge(limitMb) };
    }

    let bytes: Buffer;
    try {
      bytes = await this.gateway.downloadFile(attachment.fileId, this.receipts.maxFileSizeBytes);
    } catch (err) {
      if (err instanceof ResponseTooLargeError) {
        return { text: this.replies.receiptTooLarge(limitMb) };
      }
      throw err; // transient: the update processor retries it
    }

    const result = await this.receipts.submit(user, bytes, message.timestamp);
    switch (result.kind) {
      case 'draft':
      case 'pending_exists': {
        await this.conversation.awaitReceiptConfirm(
          user.id,
          result.draft.id,
          result.draft.expiresAt,
        );
        return {
          text: this.replies.receiptPreview(
            result.extraction,
            this.receipts.walletFor(user, result.extraction),
            user.timezone,
            result.kind === 'pending_exists' ? 'duplicate' : undefined,
          ),
        };
      }
      case 'already_confirmed':
        return { text: this.replies.receiptAlreadyRecorded() };
      case 'rate_limited':
        return { text: this.replies.receiptRateLimited() };
      case 'rejected_image':
        return { text: this.replies.receiptBadImage(result.reason) };
      case 'unreadable':
        return { text: this.replies.receiptUnreadable() };
      case 'busy':
        return { text: this.replies.receiptBusy() };
    }
  }

  private async confirmReceipt(user: UserEntity, message: IncomingMessage): Promise<OutgoingReply> {
    const outcome = await this.receipts.confirm(user, message.timestamp);
    await this.conversation.clear(user.id);
    switch (outcome.kind) {
      case 'confirmed': {
        const result: TransactionResult = {
          transaction: outcome.transaction,
          category: outcome.category,
        };
        let text = this.replies.receiptRecorded(result, user.timezone);
        const alerts = await this.budgets.evaluate(
          user.id,
          outcome.transaction.categoryId,
          message.timestamp,
          user.timezone,
        );
        if (alerts.length > 0) text += `\n\n${this.replies.budgetAlerts(alerts)}`;
        return { text };
      }
      case 'already_confirmed':
        return { text: this.replies.receiptAlreadyRecorded() };
      case 'expired':
        return { text: this.replies.receiptExpired() };
      default:
        return { text: this.replies.receiptGone() };
    }
  }

  private async routeFresh(
    user: UserEntity,
    intent: ParsedIntent,
    message: IncomingMessage,
  ): Promise<OutgoingReply> {
    const now = message.timestamp;

    switch (intent.type) {
      case IntentType.RecordTransaction: {
        if (intent.amount !== null) {
          return this.recordAndReply(user, intent, message.messageId, now);
        }
        await this.conversation.awaitAmount(
          user.id,
          {
            transactionType: intent.transactionType,
            description: intent.description,
            keywords: intent.keywords,
            occurredAt: intent.occurredAt.toISOString(),
            wallet: intent.wallet,
          },
          now,
        );
        return { text: this.replies.askAmount(intent.description) };
      }

      case IntentType.RecordMany: {
        if (intent.items.length > MAX_BATCH_ITEMS) {
          return { text: this.replies.tooManyItems(MAX_BATCH_ITEMS) };
        }
        return this.recordManyAndReply(user, intent.items, message.messageId, now);
      }

      case IntentType.EditTransaction: {
        const result = await this.transactions.editLast(
          user.id,
          this.onlyWallet(user) ? { ...intent, wallet: null } : intent,
        );
        return {
          text: result ? this.replies.edited(result, user.timezone) : this.replies.nothingToEdit(),
        };
      }

      case IntentType.DeleteTransaction: {
        const last = await this.transactions.getLast(user.id);
        if (!last) return { text: this.replies.nothingToDelete() };
        await this.conversation.awaitDeleteConfirm(user.id, now);
        return { text: this.replies.deleteConfirm(last) };
      }

      case IntentType.Summary: {
        const summary = await this.reports.generateSummary(
          user.id,
          intent.period,
          now,
          user.timezone,
          intent.customRange,
        );
        const wallets = await this.wallets.overview(
          user.id,
          intent.period,
          now,
          user.timezone,
          intent.customRange,
        );
        return { text: this.replies.summary(summary, wallets) };
      }

      case IntentType.SetBudget: {
        if (intent.amount === null) {
          return { text: 'Sebutkan nominal budget. Contoh: _budget makan 2 juta_' };
        }
        const result = await this.budgets.setBudget(
          user.id,
          intent.keywords,
          intent.amount,
          intent.period,
        );
        return { text: this.replies.budgetSet(result) };
      }

      case IntentType.Export: {
        const csv = await this.csvExport.export(
          user.id,
          intent.period,
          now,
          user.timezone,
          intent.customRange,
          await this.wallets.overview(
            user.id,
            intent.period,
            now,
            user.timezone,
            intent.customRange,
          ),
        );
        return {
          text: this.replies.exportCaption(csv.rowCount),
          document:
            csv.rowCount > 0
              ? { content: csv.content, filename: csv.filename, mimeType: csv.mimeType }
              : undefined,
        };
      }

      case IntentType.SetupWallets: {
        await this.conversation.awaitWalletMode(user.id, now);
        return { text: this.replies.askWalletMode() };
      }

      case IntentType.Transfer: {
        if (this.onlyWallet(user)) return { text: this.replies.transferNeedsBoth() };
        if (intent.amount === null) return { text: this.replies.askTransferAmount() };
        if (intent.from === null || intent.to === null) {
          return { text: this.replies.askTransferDirection() };
        }
        if (intent.from === intent.to) return { text: this.replies.transferSameWallet() };
        const transfer = await this.wallets.transfer(
          user.id,
          intent.from,
          intent.to,
          intent.amount,
          now,
          message.messageId,
        );
        if (!transfer) return {};
        return {
          text: this.replies.transferRecorded(transfer, await this.wallets.current(user.id)),
        };
      }

      case IntentType.DeleteTransfer: {
        const last = await this.wallets.getLastTransfer(user.id);
        if (!last) return { text: this.replies.nothingToDeleteTransfer() };
        await this.conversation.awaitDeleteConfirm(user.id, now, 'transfer');
        return { text: this.replies.deleteTransferConfirm(last) };
      }

      case IntentType.Balance:
        return { text: this.replies.balance(await this.wallets.current(user.id)) };

      case IntentType.SetOpeningBalance: {
        if (intent.wallet === null || intent.amount === null) {
          return { text: this.replies.askOpeningBalance() };
        }
        const only = this.onlyWallet(user);
        if (only !== null && only !== intent.wallet) {
          return { text: this.replies.inactiveWallet(intent.wallet) };
        }
        await this.wallets.setOpeningBalance(
          user.id,
          intent.wallet,
          intent.amount,
          now,
          message.messageId,
        );
        return { text: this.replies.openingBalanceSet(intent.wallet, intent.amount) };
      }

      case IntentType.SetDefaultWallet: {
        if (intent.wallet === null) return { text: this.replies.askDefaultWallet() };
        const only = this.onlyWallet(user);
        if (only !== null) return { text: this.replies.defaultNotNeeded(only) };
        await this.wallets.setDefault(user.id, intent.wallet);
        return { text: this.replies.defaultWalletSet(intent.wallet) };
      }

      case IntentType.ResetData: {
        await this.conversation.awaitResetConfirm(user.id, now);
        return { text: this.replies.resetConfirm() };
      }

      default:
        return { text: this.replies.compose(intent) };
    }
  }

  /** A transaction that only needs its wallet, rebuilt from the saved conversation state. */
  private pendingToIntent(p: PendingTransaction, wallet: Wallet | null): RecordTransactionIntent {
    return {
      type: IntentType.RecordTransaction,
      raw: p.raw ?? '',
      transactionType: p.transactionType,
      amount: Money.fromMajor(p.amount ?? '0'),
      description: p.description,
      keywords: p.keywords,
      occurredAt: new Date(p.occurredAt),
      wallet,
    };
  }

  /**
   * Several transactions from one message. Wallets are resolved like a single one
   * (named, then default); if some still have none and the user uses wallets, ask
   * once for all of them.
   */
  private async recordManyAndReply(
    user: UserEntity,
    items: RecordTransactionIntent[],
    messageId: string,
    now: Date,
  ): Promise<OutgoingReply> {
    const only = this.onlyWallet(user);
    const resolved = items.map((i) => ({ ...i, wallet: only ?? i.wallet ?? user.defaultWallet }));
    const missing = resolved.filter((i) => i.wallet === null);

    if (
      missing.length > 0 &&
      (user.walletMode === WalletMode.BOTH || (await this.wallets.current(user.id)).enabled)
    ) {
      await this.conversation.awaitWalletBatch(
        user.id,
        resolved.map((i) => ({
          transactionType: i.transactionType,
          description: i.description,
          keywords: i.keywords,
          occurredAt: i.occurredAt.toISOString(),
          wallet: i.wallet,
          amount: i.amount?.toDecimalString(),
          raw: i.raw,
        })),
        messageId,
        now,
      );
      return { text: this.replies.askWalletBatch(missing) };
    }
    return this.recordBatch(user, resolved, messageId, now);
  }

  /** Record every item (idempotent per item) and reply once, with one set of budget alerts. */
  private async recordBatch(
    user: UserEntity,
    items: RecordTransactionIntent[],
    messageId: string,
    now: Date,
  ): Promise<OutgoingReply> {
    // One database transaction: either every item is stored or none is.
    const results: TransactionResult[] = await this.transactions.recordMany(
      user.id,
      items,
      messageId,
    );
    if (results.length === 0) return {};

    // Evaluate once everything is saved, so usage includes the whole batch.
    const alerts = new Map<string, BudgetAlert>();
    for (const { transaction } of results) {
      if (transaction.type !== TransactionType.EXPENSE) continue;
      for (const alert of await this.budgets.evaluate(
        user.id,
        transaction.categoryId,
        now,
        user.timezone,
      )) {
        alerts.set(`${alert.categoryName}|${alert.period}`, alert);
      }
    }

    let text = this.replies.recordedMany(results, user.timezone, now);
    if (alerts.size > 0) text += `\n\n${this.replies.budgetAlerts([...alerts.values()])}`;
    return { text };
  }

  private async recordAndReply(
    user: UserEntity,
    intent: RecordTransactionIntent,
    messageId: string,
    now: Date,
  ): Promise<OutgoingReply> {
    // One-wallet users always use that wallet (any other wallet word is ignored).
    // Otherwise a wallet named in the message wins, then the user's default.
    const only = this.onlyWallet(user);
    const wallet = only ?? intent.wallet ?? user.defaultWallet;

    // Users who already use wallets but never chose a default get asked, so the
    // transaction lands in the right one. Everyone else keeps the silent behaviour.
    if (
      wallet === null &&
      intent.amount !== null &&
      (user.walletMode === WalletMode.BOTH || (await this.wallets.current(user.id)).enabled)
    ) {
      await this.conversation.awaitWallet(
        user.id,
        {
          transactionType: intent.transactionType,
          description: intent.description,
          keywords: intent.keywords,
          occurredAt: intent.occurredAt.toISOString(),
          wallet: null,
          amount: intent.amount.toDecimalString(),
          raw: intent.raw,
          messageId,
        },
        now,
      );
      return { text: this.replies.askWallet(intent.description, intent.amount) };
    }

    const result = await this.transactions.record(user.id, { ...intent, wallet }, messageId);
    if (!result) return {};

    let text = this.replies.recorded(result, user.timezone);
    if (result.transaction.type === TransactionType.EXPENSE) {
      const alerts = await this.budgets.evaluate(
        user.id,
        result.transaction.categoryId,
        now,
        user.timezone,
      );
      if (alerts.length > 0) {
        text += `\n\n${this.replies.budgetAlerts(alerts)}`;
      }
    }
    return { text };
  }

  private completePending(
    user: UserEntity,
    payload: Record<string, unknown> | null,
    amount: Money,
    message: IncomingMessage,
  ): Promise<OutgoingReply> {
    if (!payload) return Promise.resolve({});
    const pending = payload as unknown as PendingTransaction;
    const intent: RecordTransactionIntent = {
      type: IntentType.RecordTransaction,
      raw: message.text,
      transactionType: pending.transactionType,
      amount,
      description: pending.description,
      keywords: pending.keywords,
      occurredAt: new Date(pending.occurredAt),
      wallet: pending.wallet ?? null,
    };
    return this.recordAndReply(user, intent, message.messageId, message.timestamp);
  }

  /** Every user-supplied amount an intent carries. */
  private amountsIn(intent: ParsedIntent): Money[] {
    switch (intent.type) {
      case IntentType.RecordTransaction:
      case IntentType.AmountOnly:
      case IntentType.SetBudget:
      case IntentType.EditTransaction:
      case IntentType.Transfer:
      case IntentType.SetOpeningBalance:
        return intent.amount ? [intent.amount] : [];
      case IntentType.RecordMany:
        return intent.items.flatMap((item) => (item.amount ? [item.amount] : []));
      default:
        return [];
    }
  }

  /** The single active wallet for one-wallet users, or null when both / undecided. */
  private onlyWallet(user: UserEntity): Wallet | null {
    if (user.walletMode === WalletMode.CASH) return Wallet.CASH;
    if (user.walletMode === WalletMode.DIGITAL) return Wallet.DIGITAL;
    return null;
  }

  /**
   * After a brand-new user's first reply, ask which wallets they want. Skipped when
   * that reply left a follow-up question open (one pending question per user).
   */
  async walletSetupPrompt(user: UserEntity, now: Date): Promise<string | null> {
    if (await this.conversation.getActive(user.id, now)) return null;
    await this.conversation.awaitWalletMode(user.id, now);
    return this.replies.askWalletMode();
  }

  private yesNo(text: string): 'yes' | 'no' | null {
    return interpretYesNo(text);
  }
}
