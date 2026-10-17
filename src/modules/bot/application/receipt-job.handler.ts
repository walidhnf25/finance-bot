import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AuditLogRepository } from 'src/modules/audit/domain/audit-log.repository';
import { JobQueue, QUEUE_NAMES, RejectedJobError } from 'src/modules/queue/domain/job-queue';
import { UserRepository } from 'src/modules/user/domain/user.repository';
import { IncomingMessage, MessagingGateway } from '../domain/messaging.gateway.port';
import { MessageOrchestrator } from './message-orchestrator';
import { parseReceiptJob } from './receipt-job.payload';
import { RECEIPT_JOB } from './receipt-job.producer';
import { ReplyBuilder } from './reply-builder';

/** Worker settings (DI token, filled from RECEIPT_WORKER_CONCURRENCY and RECEIPT_JOB_TIMEOUT_SECONDS). */
export const RECEIPT_WORKER_OPTIONS = Symbol('RECEIPT_WORKER_OPTIONS');
export interface ReceiptWorkerOptions {
  concurrency: number;
  timeoutMs: number;
}

/**
 * The consumer of the receipts queue: the same "download, read, draft, reply" work the chat handler does
 * in-process, run in the background with retries. It only ever produces a DRAFT; recording money still needs
 * the user's "ya", exactly as in the in-process path.
 *
 * Safe to run twice for one job (jobs are delivered at least once): a draft is keyed by the image hash, so a
 * second run finds the pending draft instead of making another, and confirmation is atomic and idempotent.
 */
@Injectable()
export class ReceiptJobHandler implements OnModuleInit {
  private readonly logger = new Logger(ReceiptJobHandler.name);

  constructor(
    private readonly jobs: JobQueue,
    private readonly users: UserRepository,
    private readonly orchestrator: MessageOrchestrator,
    private readonly gateway: MessagingGateway,
    private readonly replies: ReplyBuilder,
    @Optional() private readonly audit?: AuditLogRepository,
    @Optional()
    @Inject(RECEIPT_WORKER_OPTIONS)
    private readonly options: ReceiptWorkerOptions = { concurrency: 1, timeoutMs: 300_000 },
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler(QUEUE_NAMES.receipts, RECEIPT_JOB, (data) => this.run(data), {
      timeoutMs: this.options.timeoutMs,
      concurrency: this.options.concurrency,
    });
    this.jobs.onFinalFailure(QUEUE_NAMES.receipts, RECEIPT_JOB, (data) => this.giveUp(data));
  }

  /** Reads the photo and tells the user. Throws on a transient problem so the queue retries. */
  async run(data: unknown): Promise<void> {
    const job = parseReceiptJob(data);
    const user = await this.users.findById(job.userId);
    if (!user) throw new RejectedJobError('unknown_user');
    // A job may only talk to a user it names, in that user's own chat: a forged job cannot make the bot
    // write to a stranger.
    if (user.chatId !== job.chatId) throw new RejectedJobError('chat_mismatch');

    const message: IncomingMessage = {
      messageId: job.messageId,
      from: user.telegramId,
      chatId: job.chatId,
      text: '',
      attachment: { kind: 'image', fileId: job.fileId, sizeBytes: job.sizeBytes },
      // PROCESSING time, not send time: the draft's lifetime starts when the draft exists. A job recovered after
      // a long outage would otherwise be born already expired and its "ya" would do nothing.
      timestamp: new Date(),
    };
    const reply = await this.orchestrator.readReceipt(user, message);
    if (reply.text) {
      await this.gateway.sendText(job.chatId, reply.text);
      await this.audit?.record({ userId: user.id, action: 'MESSAGE_OUT' });
    }
  }

  /** The retries are used up: say so, so the user is not left waiting for a draft that will not come. */
  async giveUp(data: unknown): Promise<void> {
    let job;
    try {
      job = parseReceiptJob(data);
    } catch (err) {
      if (err instanceof RejectedJobError) return; // not ours: no message to anyone
      throw err;
    }
    // A database error here is NOT swallowed: it surfaces in the queue's log instead of silently leaving the user waiting.
    const user = await this.users.findById(job.userId);
    if (user?.chatId !== job.chatId) return;
    await this.gateway.sendText(job.chatId, this.replies.receiptJobFailed());
    this.logger.warn('Receipt job gave up; the user was told');
  }
}
