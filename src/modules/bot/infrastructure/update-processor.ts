import { Injectable, Logger, Optional } from '@nestjs/common';
import { MetricsService } from 'src/modules/observability/metrics.service';
import { TelegramGateway } from './telegram.gateway';
import { toIncomingMessage } from './telegram-update.mapper';
import { TelegramUpdate } from './telegram.types';

export type ProcessResult = 'done' | 'retry';

/** How many times one update may fail before it is given up on (and the user is told). */
export const MAX_UPDATE_ATTEMPTS = 3;
const MAX_TRACKED = 5_000;

export const PROCESSING_FAILED_TEXT =
  'Maaf, ada gangguan saat memproses pesanmu, jadi belum tercatat. Coba kirim lagi sebentar lagi ya. 🙏';

/**
 * Runs one update through the bot with at-least-once semantics.
 *
 * Why this is safe for money: every financial write carries an idempotency key (the chat message
 * id), enforced by a database unique constraint, so processing the same update again can never
 * create a second transaction. That lets a failed update be retried instead of silently dropped.
 *
 *  - success                          -> 'done'
 *  - failure, attempts left           -> 'retry'  (poller re-runs it; the webhook answers 503 so
 *                                                  Telegram redelivers)
 *  - failure on the last attempt      -> the user is told it failed, then 'done' (a poison update
 *                                        must not be redelivered forever)
 *
 * Updates of the SAME chat are processed one at a time, in arrival order. The polling loop is already
 * sequential, but the webhook can deliver two updates of one chat concurrently ("beli kopi" then "25rb"
 * a moment later), and a multi-step dialog must see the first one's state before it handles the second.
 * Different chats do not wait for each other.
 */
@Injectable()
export class UpdateProcessor {
  private readonly logger = new Logger(UpdateProcessor.name);
  private readonly failures = new Map<number, number>();
  /** Tail of the work queued for each chat; an entry exists only while that chat has work in flight. */
  private readonly chats = new Map<string, Promise<unknown>>();

  constructor(
    private readonly telegram: TelegramGateway,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async process(update: TelegramUpdate): Promise<ProcessResult> {
    const chatId = update.message?.chat?.id;
    if (chatId === undefined) return this.run(update);

    const key = String(chatId);
    const previous = this.chats.get(key) ?? Promise.resolve();
    // `run` handles its own errors; the second handler keeps the chain alive even if one ever escapes.
    const current = previous.then(
      () => this.run(update),
      () => this.run(update),
    );
    this.chats.set(key, current);
    try {
      return await current;
    } finally {
      if (this.chats.get(key) === current) this.chats.delete(key);
    }
  }

  private async run(update: TelegramUpdate): Promise<ProcessResult> {
    try {
      await this.telegram.handleUpdate(update);
      this.failures.delete(update.update_id);
      this.metrics?.inc('update_attempts_total', { result: 'done' });
      return 'done';
    } catch (err) {
      const attempts = (this.failures.get(update.update_id) ?? 0) + 1;
      // Log the error class only: messages can embed query parameters or message text.
      this.logger.error(
        { updateId: update.update_id, attempt: attempts, error: errorName(err) },
        'Failed to process update',
      );

      if (attempts < MAX_UPDATE_ATTEMPTS) {
        this.remember(update.update_id, attempts);
        this.metrics?.inc('update_attempts_total', { result: 'retry' });
        return 'retry';
      }

      this.failures.delete(update.update_id);
      this.metrics?.inc('update_attempts_total', { result: 'given_up' });
      await this.tellUser(update);
      return 'done';
    }
  }

  private remember(updateId: number, attempts: number): void {
    this.failures.set(updateId, attempts);
    if (this.failures.size > MAX_TRACKED) {
      const oldest = this.failures.keys().next().value as number;
      this.failures.delete(oldest);
    }
  }

  /** Best effort: the failure itself may be a Telegram outage, so never throw from here. */
  private async tellUser(update: TelegramUpdate): Promise<void> {
    const message = toIncomingMessage(update);
    if (!message) return;
    try {
      await this.telegram.sendText(message.chatId, PROCESSING_FAILED_TEXT);
    } catch {
      this.logger.warn({ updateId: update.update_id }, 'Could not tell the user about the failure');
    }
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}
