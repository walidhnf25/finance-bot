import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { SlidingWindowLimiter } from 'src/common/utils/rate-limiter';
import { AuditLogRepository } from 'src/modules/audit/domain/audit-log.repository';
import { MetricsService } from 'src/modules/observability/metrics.service';
import { UserRepository } from 'src/modules/user/domain/user.repository';
import { IncomingMessage, MessagingGateway } from '../domain/messaging.gateway.port';
import { MessageDedupeService } from './message-dedupe.service';
import { MessageOrchestrator } from './message-orchestrator';
import { ReplyBuilder } from './reply-builder';

/** Longest message handled (DI token; the value comes from MAX_INPUT_CHARS). */
export const MAX_INPUT_CHARS = Symbol('MAX_INPUT_CHARS');
const DEFAULT_MAX_INPUT_CHARS = 2_000;

/**
 * Inbound pipeline: dedupe -> rate limit -> auto-register user -> audit -> orchestrate -> reply.
 * Parsing, conversation state and actions live in the MessageOrchestrator.
 *
 * A message is remembered as "handled" only AFTER it succeeded, so a retried update (see
 * UpdateProcessor) is processed again instead of being skipped; the database idempotency keys
 * make that second run harmless. The audit trail records event types and sizes, never the text.
 */
@Injectable()
export class IncomingMessageHandler implements OnModuleInit {
  private readonly logger = new Logger(IncomingMessageHandler.name);

  constructor(
    private readonly gateway: MessagingGateway,
    private readonly users: UserRepository,
    private readonly audit: AuditLogRepository,
    private readonly dedupe: MessageDedupeService,
    private readonly replies: ReplyBuilder,
    private readonly orchestrator: MessageOrchestrator,
    private readonly rateLimiter: SlidingWindowLimiter,
    @Optional() private readonly metrics?: MetricsService,
    @Optional()
    @Inject(MAX_INPUT_CHARS)
    private readonly maxInputChars: number = DEFAULT_MAX_INPUT_CHARS,
  ) {}

  onModuleInit(): void {
    this.gateway.onMessage((message) => this.handle(message));
  }

  async handle(message: IncomingMessage): Promise<void> {
    const started = performance.now();
    try {
      const outcome = await this.handleCore(message);
      this.metrics?.inc('updates_total', { outcome });
    } catch (err) {
      this.metrics?.inc('updates_total', { outcome: 'failed' });
      throw err;
    } finally {
      this.metrics?.observe('message_latency_ms', performance.now() - started);
    }
  }

  private async handleCore(
    message: IncomingMessage,
  ): Promise<'processed' | 'duplicate' | 'rate_limited' | 'too_long'> {
    if (this.dedupe.has(message.messageId)) {
      this.logger.debug('Duplicate message ignored');
      return 'duplicate';
    }

    // Refuse an oversized message before it costs anything (parsing, database, audit).
    if (message.text.length > this.maxInputChars) {
      await this.gateway.sendText(message.chatId, this.replies.tooLong(this.maxInputChars));
      this.dedupe.markDone(message.messageId);
      return 'too_long';
    }

    const decision = this.rateLimiter.tryAcquire(message.from);
    if (!decision.allowed) {
      // Warn once per window; further messages in the window are dropped silently.
      if (decision.firstRejection) {
        await this.gateway.sendText(
          message.chatId,
          this.replies.rateLimited(Math.ceil(decision.retryAfterMs / 1000)),
        );
      }
      this.dedupe.markDone(message.messageId);
      return 'rate_limited';
    }

    const { user, created } = await this.users.findOrCreate({
      telegramId: message.from,
      chatId: message.chatId,
      displayName: message.senderName,
    });

    await this.audit.record({
      userId: user.id,
      action: 'MESSAGE_IN',
      metadata: { length: message.text.length, hasImage: message.attachment !== undefined },
    });

    if (created) {
      await this.gateway.sendText(message.chatId, this.replies.onboarding(user.displayName));
    }

    const reply = await this.orchestrator.process(user, message);
    let replied = false;
    if (reply.text) {
      await this.gateway.sendText(message.chatId, reply.text);
      replied = true;
    }
    if (reply.document) {
      await this.gateway.sendDocument(
        message.chatId,
        reply.document.content,
        reply.document.filename,
        reply.document.mimeType,
      );
      replied = true;
    }
    if (replied) {
      await this.audit.record({ userId: user.id, action: 'MESSAGE_OUT' });
    }

    // New users choose their wallets right after their first reply.
    if (created) {
      const prompt = await this.orchestrator.walletSetupPrompt(user, message.timestamp);
      if (prompt) await this.gateway.sendText(message.chatId, prompt);
    }

    this.dedupe.markDone(message.messageId);
    return 'processed';
  }
}
