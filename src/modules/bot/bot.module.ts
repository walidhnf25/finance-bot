import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SlidingWindowLimiter } from 'src/common/utils/rate-limiter';
import { AuditModule } from '../audit/audit.module';
import { BudgetModule } from '../budget/budget.module';
import { ConversationModule } from '../conversation/conversation.module';
import { ParserModule } from '../parser/parser.module';
import { ReceiptModule } from '../receipt/receipt.module';
import { ReportModule } from '../report/report.module';
import { TransactionModule } from '../transaction/transaction.module';
import { UserModule } from '../user/user.module';
import { WalletModule } from '../wallet/wallet.module';
import { IncomingMessageHandler, MAX_INPUT_CHARS } from './application/incoming-message.handler';
import { MessageDedupeService } from './application/message-dedupe.service';
import { MessageOrchestrator } from './application/message-orchestrator';
import { ReceiptJobHandler, RECEIPT_WORKER_OPTIONS } from './application/receipt-job.handler';
import { ReceiptJobProducer, RECEIPT_JOB_OPTIONS } from './application/receipt-job.producer';
import { UpdateProcessor } from './infrastructure/update-processor';
import { ReplyBuilder } from './application/reply-builder';
import { MessagingGateway } from './domain/messaging.gateway.port';
import { TelegramWebhookController } from './infrastructure/telegram-webhook.controller';
import { TelegramGateway } from './infrastructure/telegram.gateway';
import { TelegramPoller } from './infrastructure/telegram.poller';

/**
 * Chat delivery module. Binds the MessagingGateway port to Telegram, exposes
 * the webhook endpoint and wires the inbound orchestrator (parsing,
 * conversation state, actions).
 */
@Module({
  imports: [
    UserModule,
    ParserModule,
    AuditModule,
    TransactionModule,
    ConversationModule,
    BudgetModule,
    ReportModule,
    WalletModule,
    ReceiptModule,
  ],
  controllers: [TelegramWebhookController],
  providers: [
    TelegramGateway,
    { provide: MessagingGateway, useExisting: TelegramGateway },
    TelegramPoller,
    MessageDedupeService,
    UpdateProcessor,
    {
      provide: SlidingWindowLimiter,
      useFactory: (config: ConfigService) =>
        new SlidingWindowLimiter(config.get<number>('telegram.userRateLimitPerMinute', 30), 60_000),
      inject: [ConfigService],
    },
    {
      provide: MAX_INPUT_CHARS,
      useFactory: (config: ConfigService) => config.get<number>('limits.maxInputChars', 2_000),
      inject: [ConfigService],
    },
    ReplyBuilder,
    {
      provide: RECEIPT_JOB_OPTIONS,
      useFactory: (config: ConfigService) => ({
        attempts: config.get<number>('queue.receiptAttempts', 3),
        backoffMs: config.get<number>('queue.receiptBackoffMs', 5_000),
      }),
      inject: [ConfigService],
    },
    {
      provide: RECEIPT_WORKER_OPTIONS,
      useFactory: (config: ConfigService) => ({
        concurrency: config.get<number>('queue.receiptConcurrency', 1),
        timeoutMs: config.get<number>('queue.receiptTimeoutMs', 300_000),
      }),
      inject: [ConfigService],
    },
    ReceiptJobProducer,
    ReceiptJobHandler,
    MessageOrchestrator,
    IncomingMessageHandler,
  ],
  exports: [MessagingGateway],
})
export class BotModule {}
