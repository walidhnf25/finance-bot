import pino from 'pino';
import { LOG_REDACT_PATHS } from './logger.module';

/** Logs one object through a real pino logger configured like the app's and returns the JSON line. */
function logLine(payload: Record<string, unknown>): string {
  let out = '';
  const logger = pino(
    { redact: { paths: LOG_REDACT_PATHS, remove: true } },
    { write: (chunk: string) => (out += chunk) },
  );
  logger.info(payload, 'x');
  return out;
}

describe('log redaction', () => {
  const SECRET = 'S3cr3t-value-that-must-never-be-logged';

  it.each([
    [
      'the webhook secret header',
      { req: { headers: { 'x-telegram-bot-api-secret-token': SECRET } } },
    ],
    ['an authorization header', { req: { headers: { authorization: `Bearer ${SECRET}` } } }],
    ['a cookie', { req: { headers: { cookie: `sid=${SECRET}` } } }],
    ['a bot token', { config: { botToken: SECRET } }],
    ['a generic token', { client: { token: SECRET } }],
    ['a secret', { config: { secret: SECRET } }],
    ['a webhook secret', { telegram: { webhookSecret: SECRET } }],
    ['an api key', { provider: { apiKey: SECRET } }],
    ['a passphrase', { backup: { passphrase: SECRET } }],
    ['a password', { db: { password: SECRET } }],
    ['a database url', { env: { databaseUrl: `postgresql://u:${SECRET}@h/db` } }],
    ['a redis url', { env: { redisUrl: `redis://:${SECRET}@h` } }],
  ])('removes %s from the log line', (_name, payload) => {
    const line = logLine(payload);
    expect(line).toContain('"msg":"x"'); // the line itself is still written
    expect(line).not.toContain(SECRET);
  });

  it('keeps ordinary fields', () => {
    expect(logLine({ updateId: 7, attempt: 2 })).toContain('"updateId":7');
  });
});
