/**
 * Boots the REAL application (AppModule, real PostgreSQL test database, real repositories,
 * services, parser, orchestrator, webhook controller) with exactly one substitution: the outbound
 * Telegram HTTP calls are captured by {@link FakeTelegramGateway}, so no real Telegram traffic
 * is generated. Inbound updates are delivered through the real HTTP webhook endpoint.
 *
 * NOTE for reports: this proves everything behind the transport boundary. It does NOT prove that
 * Telegram itself delivers/accepts anything; that needs a real bot token and was not exercised.
 */
import './env';
import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PrismaService } from '../../src/database/prisma.service';
import { MetricsService } from '../../src/modules/observability/metrics.service';
import { TelegramGateway } from '../../src/modules/bot/infrastructure/telegram.gateway';
import { TelegramUpdate } from '../../src/modules/bot/infrastructure/telegram.types';

export interface SentMessage {
  to: string;
  text: string;
}
export interface SentDocument {
  to: string;
  filename: string;
  content: Buffer;
}

export class FakeTelegramGateway extends TelegramGateway {
  readonly texts: SentMessage[] = [];
  readonly documents: SentDocument[] = [];
  /** Bytes returned for downloadFile (a receipt photo), keyed by file id. */
  readonly files = new Map<string, Buffer>();
  failSends = false;

  constructor(config: ConfigService, metrics?: MetricsService) {
    super(config, metrics);
  }

  override sendText(to: string, text: string): Promise<void> {
    if (this.failSends) return Promise.reject(new Error('telegram down'));
    this.texts.push({ to, text });
    return Promise.resolve();
  }

  override sendDocument(to: string, content: Buffer, filename: string): Promise<void> {
    this.documents.push({ to, filename, content });
    return Promise.resolve();
  }

  override downloadFile(fileId: string, maxBytes: number): Promise<Buffer> {
    const file = this.files.get(fileId);
    if (!file) return Promise.reject(new Error('no such file'));
    if (file.length > maxBytes) return Promise.reject(new Error('too large'));
    return Promise.resolve(file);
  }

  /** Text of the last message sent to a chat. */
  last(chatId?: string): string {
    const list = chatId ? this.texts.filter((t) => t.to === chatId) : this.texts;
    return list[list.length - 1]?.text ?? '';
  }

  clear(): void {
    this.texts.length = 0;
    this.documents.length = 0;
  }
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  telegram: FakeTelegramGateway;
  secret: string;
  /** Deliver an update through the real webhook endpoint, with the right secret header. */
  deliver(update: TelegramUpdate, headers?: Record<string, string>): request.Test;
  /** A chat message from `userId` (private chat id = user id). */
  say(userId: number, text: string, messageId?: number): request.Test;
  close(): Promise<void>;
}

let messageCounter = 1000;

/**
 * Every test message is stamped with this fixed instant (mid-month, noon in Jakarta) unless a test
 * passes its own `date`. The app derives "today", "this month" and all expiry windows from the
 * message timestamp, so the suite no longer depends on the calendar date it runs on.
 */
export const E2E_NOW = new Date('2026-07-15T05:00:00.000Z');
export const E2E_DATE = '2026-07-15';

export function buildUpdate(
  userId: number,
  text: string,
  messageId = ++messageCounter,
  extra: Partial<NonNullable<TelegramUpdate['message']>> = {},
): TelegramUpdate {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: userId, is_bot: false, first_name: `User${userId}` },
      chat: { id: userId, type: 'private' },
      date: Math.floor(E2E_NOW.getTime() / 1000),
      text,
      ...extra,
    },
  };
}

/**
 * @param env extra/overriding environment for this app instance (restored on close).
 */
export async function createTestApp(
  env: Record<string, string> = {},
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<TestApp> {
  const secret = 'e2e-webhook-secret-0123456789';
  const overrides: Record<string, string> = {
    TELEGRAM_POLLING: 'false', // webhook mode: the real HTTP boundary
    TELEGRAM_WEBHOOK_SECRET: secret,
    ...env,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  const restoreEnv = (): void => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  let app: INestApplication;
  try {
    const moduleRef = await customize(Test.createTestingModule({ imports: [AppModule] }))
      .overrideProvider(TelegramGateway)
      .useFactory({
        factory: (config: ConfigService, metrics: MetricsService) =>
          new FakeTelegramGateway(config, metrics),
        inject: [ConfigService, MetricsService],
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app, { swagger: false });
    await app.init();
  } catch (err) {
    // A deliberately invalid configuration must not leak its env into the next test.
    restoreEnv();
    throw err;
  }

  const telegram = app.get<FakeTelegramGateway>(TelegramGateway);
  const prisma = app.get(PrismaService);
  const http = () => request(app.getHttpServer() as Server);

  const deliver = (update: TelegramUpdate, headers: Record<string, string> = {}): request.Test =>
    http()
      .post('/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', secret)
      .set(headers)
      .send(update);

  return {
    app,
    prisma,
    telegram,
    secret,
    deliver,
    say: (userId, text, messageId) => deliver(buildUpdate(userId, text, messageId)),
    close: async () => {
      await app.close();
      restoreEnv();
    },
  };
}
