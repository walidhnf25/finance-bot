import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CoreModule } from './common/core.module';
import { LoggerModule } from './common/logger/logger.module';
import { AppConfigModule } from './config/app-config.module';
import { PrismaModule } from './database/prisma.module';
import { AuditModule } from './modules/audit/audit.module';
import { BotModule } from './modules/bot/bot.module';
import { BudgetModule } from './modules/budget/budget.module';
import { CategoryModule } from './modules/category/category.module';
import { ConversationModule } from './modules/conversation/conversation.module';
import { HealthModule } from './modules/health/health.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { ParserModule } from './modules/parser/parser.module';
import { QueueModule } from './modules/queue/queue.module';
import { RetentionModule } from './modules/retention/retention.module';
import { TransactionModule } from './modules/transaction/transaction.module';
import { UserModule } from './modules/user/user.module';

/**
 * Root module. Wires global cross-cutting concerns (config, logging, database),
 * the persistence modules (repository ports), and feature modules (parser,
 * Telegram bot delivery, health).
 */
@Module({
  imports: [
    // Infrastructure & cross-cutting
    AppConfigModule,
    LoggerModule,
    CoreModule,
    ObservabilityModule,
    PrismaModule,
    // Persistence (PostgreSQL)
    UserModule,
    CategoryModule,
    TransactionModule,
    BudgetModule,
    ConversationModule,
    AuditModule,
    // Business logic
    ParserModule,
    // Delivery
    BotModule,
    // Ops
    HealthModule,
    QueueModule,
    RetentionModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
