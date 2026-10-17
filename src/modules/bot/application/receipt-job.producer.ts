import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MetricsService } from 'src/modules/observability/metrics.service';
import { JobQueue, QUEUE_NAMES, QueueUnavailableError } from 'src/modules/queue/domain/job-queue';
import { UserEntity } from 'src/modules/user/domain/user.entity';
import { IncomingMessage } from '../domain/messaging.gateway.port';
import { ReceiptJobPayload, receiptJobId } from './receipt-job.payload';

export const RECEIPT_JOB = 'read';
/** Tries per receipt job and the first retry delay (DI token, filled from RECEIPT_JOB_ATTEMPTS). */
export const RECEIPT_JOB_OPTIONS = Symbol('RECEIPT_JOB_OPTIONS');
export interface ReceiptJobOptions {
  attempts: number;
  backoffMs: number;
}

export type QueuedReceipt = 'queued' | 'duplicate';

/**
 * Hands a receipt photo to the background queue when one is configured. Returns null when the photo must be
 * read right now instead (queues off, or Redis unreachable): the caller then runs the same work in-process,
 * so a Redis outage never costs the user a receipt.
 */
@Injectable()
export class ReceiptJobProducer {
  private readonly logger = new Logger(ReceiptJobProducer.name);

  constructor(
    private readonly jobs: JobQueue,
    @Optional()
    @Inject(RECEIPT_JOB_OPTIONS)
    private readonly options: ReceiptJobOptions = { attempts: 3, backoffMs: 5_000 },
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  get enabled(): boolean {
    return this.jobs.enabled;
  }

  async tryEnqueue(user: UserEntity, message: IncomingMessage): Promise<QueuedReceipt | null> {
    const attachment = message.attachment;
    if (!this.jobs.enabled || !attachment) return null;
    const payload: ReceiptJobPayload = {
      userId: user.id,
      chatId: message.chatId,
      messageId: message.messageId,
      fileId: attachment.fileId,
      sizeBytes: attachment.sizeBytes,
      receivedAt: message.timestamp.toISOString(),
    };
    try {
      const result = await this.jobs.enqueue(QUEUE_NAMES.receipts, RECEIPT_JOB, payload, {
        jobId: receiptJobId(message.messageId),
        attempts: this.options.attempts,
        backoffMs: this.options.backoffMs,
      });
      return result === 'duplicate' ? 'duplicate' : 'queued';
    } catch (err) {
      if (!(err instanceof QueueUnavailableError)) throw err;
      this.metrics?.inc('queue_jobs_total', { queue: 'receipts', outcome: 'fallback' });
      this.logger.warn('Queue unreachable; reading the receipt in-process instead');
      return null;
    }
  }
}
