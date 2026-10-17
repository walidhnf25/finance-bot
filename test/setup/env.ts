/**
 * Runs before every test file (jest `setupFiles`). Forces a hermetic environment: the TEST
 * database, no real Telegram token, no logging noise. Must be imported first by test-app.ts.
 */
import 'dotenv/config';
import { assertSafeTestDatabase, resolveTestDatabaseUrl } from '../../src/testing/db-guard';

const testUrl = resolveTestDatabaseUrl(process.env);
assertSafeTestDatabase(testUrl);

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testUrl;
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST-TOKEN-NOT-REAL-0123456789abcdef';
process.env.TELEGRAM_POLLING = 'true';
process.env.TELEGRAM_WEBHOOK_SECRET = '';
process.env.TELEGRAM_ALLOW_PUBLIC = 'true';
process.env.TELEGRAM_ALLOWED_USER_IDS = '';
process.env.USER_RATE_LIMIT_PER_MINUTE = '10000';
process.env.LOG_LEVEL = 'silent';
process.env.OLLAMA_MODEL = '';
// Tests never talk to a real model; the receipt e2e starts a fake Ollama instead.
process.env.AI_PROVIDER = 'none';

// Expected constraint violations are logged by PrismaService; keep test output readable.
import { Logger } from '@nestjs/common';
Logger.overrideLogger(false);

// The background queue is opt-in. A REDIS_URL in a developer's own .env must never leak into the ordinary
// suites; the queue suites (test/queue) switch it on explicitly.
process.env.REDIS_URL = '';
