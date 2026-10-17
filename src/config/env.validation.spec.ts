import { EnvValidationError, isLoopbackHost, validateEnv } from './env.validation';

const TOKEN = '123456789:TEST-TOKEN-NOT-REAL-0123456789abcde';
const SECRET = 'a-strong-webhook-secret-123';

/** The smallest environment that is valid in the default (polling) mode. */
const base = (over: Record<string, string> = {}): Record<string, string> => ({
  DATABASE_URL: 'postgresql://finance_bot:pw@127.0.0.1:55432/finance_bot',
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_ALLOWED_USER_IDS: '1001',
  ...over,
});

function issuesOf(raw: Record<string, unknown>): string[] {
  try {
    validateEnv(raw);
  } catch (err) {
    if (err instanceof EnvValidationError) return err.issues;
    throw err;
  }
  return [];
}

describe('validateEnv', () => {
  it('accepts a minimal configuration and applies safe defaults', () => {
    const env = validateEnv(base());
    expect(env.host).toBe('127.0.0.1'); // loopback unless told otherwise
    expect(env.telegram.polling).toBe(true); // polling mode needs no public URL
    expect(env.swagger.enabled).toBe(false);
    expect(env.ai.provider).toBe('ollama');
    expect(env.ai.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
    expect(env.telegram.allowedUserIds).toEqual(['1001']);
    expect(env.telegram.allowPublic).toBe(false);
  });

  describe('webhook mode fails closed without a strong secret', () => {
    const webhook = (secret?: string) =>
      base({
        TELEGRAM_POLLING: 'false',
        ...(secret === undefined ? {} : { TELEGRAM_WEBHOOK_SECRET: secret }),
      });

    it('refuses to start with no secret', () => {
      expect(issuesOf(webhook())).toEqual([expect.stringContaining('TELEGRAM_WEBHOOK_SECRET')]);
      expect(issuesOf(webhook(''))).toEqual([expect.stringContaining('TELEGRAM_WEBHOOK_SECRET')]);
      expect(issuesOf(webhook('   '))).toEqual([
        expect.stringContaining('TELEGRAM_WEBHOOK_SECRET'),
      ]);
    });

    it.each([
      ['short', 'too-short'],
      ['illegal characters', 'has spaces and !! symbols 123456'],
    ])('refuses a %s secret', (_name, secret) => {
      expect(issuesOf(webhook(secret))).toEqual([
        expect.stringContaining('TELEGRAM_WEBHOOK_SECRET'),
      ]);
    });

    it('accepts a valid secret, and does not require one in polling mode', () => {
      expect(issuesOf(webhook(SECRET))).toEqual([]);
      expect(issuesOf(base({ TELEGRAM_POLLING: 'true' }))).toEqual([]);
    });
  });

  describe('access policy is explicit', () => {
    it('refuses an empty allowlist that is not explicitly public', () => {
      const raw = base({ TELEGRAM_ALLOWED_USER_IDS: '' });
      expect(issuesOf(raw)).toEqual([expect.stringContaining('TELEGRAM_ALLOW_PUBLIC=true')]);
      expect(issuesOf({ ...raw, TELEGRAM_ALLOWED_USER_IDS: undefined })).toHaveLength(1);
      expect(issuesOf({ ...raw, TELEGRAM_ALLOWED_USER_IDS: ' , ,' })).toHaveLength(1);
    });

    it('accepts an explicit public bot', () => {
      const env = validateEnv(
        base({ TELEGRAM_ALLOWED_USER_IDS: '', TELEGRAM_ALLOW_PUBLIC: 'true' }),
      );
      expect(env.telegram.allowPublic).toBe(true);
      expect(env.telegram.allowedUserIds).toEqual([]);
    });

    it('refuses to combine an allowlist with public access', () => {
      expect(issuesOf(base({ TELEGRAM_ALLOW_PUBLIC: 'true' }))).toEqual([
        expect.stringContaining('conflicts'),
      ]);
    });

    it('validates every allowlist entry without echoing it back', () => {
      const issues = issuesOf(base({ TELEGRAM_ALLOWED_USER_IDS: '1001, 12ab34, 5005' }));
      expect(issues).toEqual([expect.stringContaining('entry 2')]);
      expect(issues.join()).not.toContain('12ab34');
    });

    it('parses a multi-user allowlist', () => {
      expect(
        validateEnv(base({ TELEGRAM_ALLOWED_USER_IDS: '1001, 2002 ,3003' })).telegram
          .allowedUserIds,
      ).toEqual(['1001', '2002', '3003']);
    });
  });

  describe('network exposure', () => {
    it.each(['127.0.0.1', '127.1.2.3', 'localhost', '::1'])(
      'allows the loopback host %s',
      (host) => {
        expect(issuesOf(base({ HOST: host }))).toEqual([]);
        expect(isLoopbackHost(host)).toBe(true);
      },
    );

    it.each(['0.0.0.0', '192.168.1.10', 'example.com'])(
      'needs ALLOW_REMOTE_BIND for %s',
      (host) => {
        expect(issuesOf(base({ HOST: host }))).toEqual([
          expect.stringContaining('ALLOW_REMOTE_BIND'),
        ]);
        expect(issuesOf(base({ HOST: host, ALLOW_REMOTE_BIND: 'true' }))).toEqual([]);
        expect(isLoopbackHost(host)).toBe(false);
      },
    );
  });

  describe('required values and formats', () => {
    it('requires the database URL, and only accepts PostgreSQL', () => {
      expect(issuesOf({ ...base(), DATABASE_URL: undefined })).toEqual([
        expect.stringContaining('DATABASE_URL: is required'),
      ]);
      expect(issuesOf(base({ DATABASE_URL: 'mysql://x' }))).toEqual([
        expect.stringContaining('postgresql://'),
      ]);
      expect(issuesOf(base({ DATABASE_URL: 'postgres://u:p@h/db' }))).toEqual([]);
    });

    it('requires a plausible bot token', () => {
      expect(issuesOf({ ...base(), TELEGRAM_BOT_TOKEN: undefined })).toEqual([
        expect.stringContaining('TELEGRAM_BOT_TOKEN'),
      ]);
      expect(issuesOf(base({ TELEGRAM_BOT_TOKEN: 'nonsense' }))).toEqual([
        expect.stringContaining('TELEGRAM_BOT_TOKEN'),
      ]);
    });

    it('never echoes a secret value in an error message', () => {
      const raw = base({
        DATABASE_URL: 'mysql://user:SuperSecretPassw0rd@host/db',
        TELEGRAM_BOT_TOKEN: 'leaky-token-value',
        TELEGRAM_POLLING: 'false',
        TELEGRAM_WEBHOOK_SECRET: 'bad secret value!!',
      });
      const message = (() => {
        try {
          validateEnv(raw);
          return '';
        } catch (err) {
          return (err as Error).message;
        }
      })();
      expect(message).not.toContain('SuperSecretPassw0rd');
      expect(message).not.toContain('leaky-token-value');
      expect(message).not.toContain('bad secret value');
    });

    it('reports every problem at once', () => {
      const issues = issuesOf({ NODE_ENV: 'prod', HOST: '0.0.0.0' });
      expect(issues.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('typed values', () => {
    it.each([
      ['true', true],
      ['1', true],
      ['YES', true],
      ['false', false],
      ['0', false],
      ['off', false],
    ])('reads boolean %s', (value, expected) => {
      expect(validateEnv(base({ LOG_PRETTY: value })).logPretty).toBe(expected);
    });

    it('rejects a boolean it cannot read instead of silently defaulting', () => {
      expect(issuesOf(base({ LOG_PRETTY: 'maybe' }))).toEqual([
        expect.stringContaining('LOG_PRETTY'),
      ]);
    });

    it('bounds numbers', () => {
      expect(issuesOf(base({ PORT: '0' }))).toHaveLength(1);
      expect(issuesOf(base({ PORT: '70000' }))).toHaveLength(1);
      expect(issuesOf(base({ PORT: 'abc' }))).toHaveLength(1);
      expect(issuesOf(base({ USER_RATE_LIMIT_PER_MINUTE: '0' }))).toHaveLength(1);
      expect(issuesOf(base({ RECEIPT_MAX_FILE_SIZE_BYTES: '5' }))).toHaveLength(1);
      expect(validateEnv(base({ PORT: '4000' })).port).toBe(4000);
    });

    it('validates the Ollama settings', () => {
      expect(issuesOf(base({ OLLAMA_BASE_URL: 'not a url' }))).toHaveLength(1);
      expect(issuesOf(base({ OLLAMA_BASE_URL: 'ftp://host' }))).toHaveLength(1);
      expect(issuesOf(base({ AI_PROVIDER: 'openai' }))).toEqual([
        expect.stringContaining('AI_PROVIDER'),
      ]);
      expect(
        validateEnv(base({ OLLAMA_BASE_URL: 'http://localhost:11434///' })).ai.ollamaBaseUrl,
      ).toBe('http://localhost:11434');
      expect(validateEnv(base({ OLLAMA_MODEL: 'qwen3-vl:8b' })).ai.ollamaModel).toBe('qwen3-vl:8b');
    });

    it('only accepts a known NODE_ENV', () => {
      expect(issuesOf(base({ NODE_ENV: 'staging' }))).toEqual([
        expect.stringContaining('NODE_ENV'),
      ]);
      expect(validateEnv(base({ NODE_ENV: 'production' })).nodeEnv).toBe('production');
    });
  });
});

describe('validateEnv: optional background queue (Redis)', () => {
  it('is off by default, with conservative worker settings', () => {
    const { queue } = validateEnv(base());
    expect(queue.redisUrl).toBe('');
    expect(queue.receiptConcurrency).toBe(1);
    expect(queue.receiptAttempts).toBe(3);
    expect(queue.keyPrefix).toBe('finance-bot:');
  });

  it('accepts a loopback Redis without a password', () => {
    expect(issuesOf(base({ REDIS_URL: 'redis://127.0.0.1:16379/15' }))).toEqual([]);
    expect(issuesOf(base({ REDIS_URL: 'redis://localhost:6379' }))).toEqual([]);
    expect(issuesOf(base({ REDIS_URL: 'redis://[::1]:6379' }))).toEqual([]);
  });

  it('refuses a non-loopback Redis without a password unless explicitly allowed', () => {
    const url = 'redis://10.0.0.5:6379';
    expect(issuesOf(base({ REDIS_URL: url }))).toEqual([expect.stringContaining('REDIS_URL')]);
    expect(issuesOf(base({ REDIS_URL: 'redis://:s3cret@10.0.0.5:6379' }))).toEqual([]);
    expect(issuesOf(base({ REDIS_URL: url, REDIS_ALLOW_UNAUTHENTICATED: 'true' }))).toEqual([]);
  });

  it.each(['http://127.0.0.1:6379', 'not a url', '127.0.0.1:6379', 'redis://'])(
    'rejects the malformed REDIS_URL %j',
    (url) => expect(issuesOf(base({ REDIS_URL: url })).length).toBeGreaterThan(0),
  );

  it('bounds the worker settings and the key prefix', () => {
    expect(issuesOf(base({ RECEIPT_WORKER_CONCURRENCY: '0' }))).toEqual([
      expect.stringContaining('RECEIPT_WORKER_CONCURRENCY'),
    ]);
    expect(issuesOf(base({ RECEIPT_WORKER_CONCURRENCY: '5' }))).toEqual([
      expect.stringContaining('RECEIPT_WORKER_CONCURRENCY'),
    ]);
    expect(issuesOf(base({ RECEIPT_JOB_ATTEMPTS: '11' }))).toEqual([
      expect.stringContaining('RECEIPT_JOB_ATTEMPTS'),
    ]);
    expect(issuesOf(base({ REDIS_KEY_PREFIX: 'bad prefix!' }))).toEqual([
      expect.stringContaining('REDIS_KEY_PREFIX'),
    ]);
    expect(validateEnv(base({ RECEIPT_JOB_TIMEOUT_SECONDS: '60' })).queue.receiptTimeoutMs).toBe(
      60_000,
    );
  });
});
