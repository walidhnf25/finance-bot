/**
 * Environment validation. Fails fast at startup with every problem listed at once, and NEVER
 * echoes a value back (tokens, URLs with passwords, id lists) — only variable names.
 *
 * Security-relevant rules enforced here (each has a regression test):
 *  - webhook mode requires a strong TELEGRAM_WEBHOOK_SECRET (no silent "verification off");
 *  - the bot is either restricted (TELEGRAM_ALLOWED_USER_IDS) or explicitly public
 *    (TELEGRAM_ALLOW_PUBLIC=true); an empty allowlist is never read as "everyone";
 *  - binding the HTTP server beyond loopback needs an explicit ALLOW_REMOTE_BIND=true.
 */

export type NodeEnv = 'development' | 'production' | 'test';

export interface Env {
  nodeEnv: NodeEnv;
  port: number;
  host: string;
  allowRemoteBind: boolean;
  appName: string;
  timezone: string;
  logLevel: string;
  logPretty: boolean;
  databaseUrl: string;
  telegram: {
    botToken: string;
    polling: boolean;
    webhookSecret: string;
    allowedUserIds: string[];
    allowPublic: boolean;
    /** Messages one user may send per minute. */
    userRateLimitPerMinute: number;
  };
  ai: {
    provider: 'ollama' | 'none';
    ollamaBaseUrl: string;
    ollamaModel: string;
    timeoutMs: number;
    maxResponseBytes: number;
    /** Consecutive failures that pause the AI, and for how long (circuit breaker). */
    breakerFailures: number;
    breakerCooldownMs: number;
  };
  receipt: {
    maxFileSizeBytes: number;
    maxPixels: number;
    pendingTtlMinutes: number;
    maxPerHour: number;
    /** auto: model only when the deterministic reader is unsure; always; never. */
    aiMode: 'auto' | 'always' | 'never';
  };
  swagger: { enabled: boolean; path: string };
  limits: {
    /** Longest message handled; longer ones are refused before any parsing or database work. */
    maxInputChars: number;
  };
  retention: {
    intervalHours: number;
    /** Unconfirmed (CANCELLED / EXPIRED) receipt drafts are deleted after this many days; 0 keeps them. */
    receiptDraftDays: number;
    /** Audit events are deleted after this many days; 0 keeps them. */
    auditDays: number;
  };
  /**
   * Optional background queues (BullMQ on Redis). Empty redisUrl = off: everything runs in-process exactly as
   * before.
   */
  queue: {
    redisUrl: string;
    connectTimeoutMs: number;
    keyPrefix: string;
    /** Receipt photos read at the same time by the worker (OCR itself is serial; keep this low). */
    receiptConcurrency: number;
    /** Total tries of one receipt job (the first run counts). */
    receiptAttempts: number;
    /** First retry delay of a receipt job; doubles on every further retry. */
    receiptBackoffMs: number;
    /** A receipt job running longer than this is failed and its lock released. */
    receiptTimeoutMs: number;
  };
}

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

type Raw = Record<string, unknown>;

const str = (raw: Raw, key: string): string | undefined => {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
};

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function validateEnv(raw: Raw): Env {
  const issues: string[] = [];

  const bool = (key: string, fallback: boolean): boolean => {
    const v = str(raw, key);
    if (v === undefined) return fallback;
    const t = v.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(t)) return true;
    if (['false', '0', 'no', 'off'].includes(t)) return false;
    issues.push(`${key}: must be true or false`);
    return fallback;
  };
  const int = (key: string, fallback: number, min: number, max: number): number => {
    const v = str(raw, key);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      issues.push(`${key}: must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };
  const required = (key: string): string => {
    const v = str(raw, key);
    if (v === undefined) {
      issues.push(`${key}: is required`);
      return '';
    }
    return v;
  };

  const nodeEnvRaw = str(raw, 'NODE_ENV') ?? 'development';
  const nodeEnv = (['development', 'production', 'test'] as const).find((n) => n === nodeEnvRaw);
  if (!nodeEnv) issues.push('NODE_ENV: must be development, production or test');

  // ---- HTTP server ----
  const host = str(raw, 'HOST') ?? '127.0.0.1';
  const allowRemoteBind = bool('ALLOW_REMOTE_BIND', false);
  if (!isLoopbackHost(host) && !allowRemoteBind) {
    issues.push('HOST: a non-loopback address needs ALLOW_REMOTE_BIND=true (the API has no login)');
  }

  // ---- database ----
  const databaseUrl = required('DATABASE_URL');
  if (databaseUrl && !/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    issues.push('DATABASE_URL: must be a postgresql:// URL');
  }

  // ---- telegram ----
  const botToken = required('TELEGRAM_BOT_TOKEN');
  if (botToken && !/^\d{3,}:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    issues.push('TELEGRAM_BOT_TOKEN: does not look like a BotFather token');
  }
  const polling = bool('TELEGRAM_POLLING', true);
  const webhookSecret = str(raw, 'TELEGRAM_WEBHOOK_SECRET') ?? '';
  if (!polling) {
    if (!webhookSecret) {
      issues.push(
        'TELEGRAM_WEBHOOK_SECRET: is required when TELEGRAM_POLLING=false (webhook mode)',
      );
    } else if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
      issues.push(
        'TELEGRAM_WEBHOOK_SECRET: must be 16-256 characters of A-Z a-z 0-9 _ - (Telegram rules)',
      );
    }
  }

  const allowedUserIds = (str(raw, 'TELEGRAM_ALLOWED_USER_IDS') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  allowedUserIds.forEach((id, i) => {
    if (!/^\d{1,20}$/.test(id)) {
      issues.push(`TELEGRAM_ALLOWED_USER_IDS: entry ${i + 1} is not a numeric Telegram user id`);
    }
  });
  const allowPublic = bool('TELEGRAM_ALLOW_PUBLIC', false);
  if (allowedUserIds.length > 0 && allowPublic) {
    issues.push('TELEGRAM_ALLOW_PUBLIC: conflicts with TELEGRAM_ALLOWED_USER_IDS (pick one)');
  }
  if (allowedUserIds.length === 0 && !allowPublic) {
    issues.push(
      'TELEGRAM_ALLOWED_USER_IDS: set it to restrict the bot, or set TELEGRAM_ALLOW_PUBLIC=true to ' +
        'explicitly allow anyone (an empty list is not treated as "everyone")',
    );
  }

  // ---- AI ----
  const aiProviderRaw = str(raw, 'AI_PROVIDER') ?? 'ollama';
  const aiProvider = (['ollama', 'none'] as const).find((p) => p === aiProviderRaw);
  if (!aiProvider) issues.push('AI_PROVIDER: must be ollama or none');
  const ollamaBaseUrl = str(raw, 'OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434';
  try {
    const u = new URL(ollamaBaseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
  } catch {
    issues.push('OLLAMA_BASE_URL: must be an http(s) URL');
  }

  const aiModeRaw = str(raw, 'RECEIPT_AI_MODE') ?? 'auto';
  const aiMode = (['auto', 'always', 'never'] as const).find((m) => m === aiModeRaw);
  if (!aiMode) issues.push('RECEIPT_AI_MODE: must be auto, always or never');

  const swaggerEnabled = bool('SWAGGER_ENABLED', false);

  // ---- optional queue backend (Redis) ----
  const redisUrl = str(raw, 'REDIS_URL') ?? '';
  const keyPrefix = str(raw, 'REDIS_KEY_PREFIX') ?? 'finance-bot:';
  if (!/^[A-Za-z0-9_:-]{1,32}$/.test(keyPrefix)) {
    issues.push('REDIS_KEY_PREFIX: letters, digits, _ : - only (max 32)');
  }
  if (redisUrl) {
    if (!/^rediss?:\/\//.test(redisUrl)) {
      issues.push('REDIS_URL: must start with redis:// or rediss://');
    } else {
      try {
        const u = new URL(redisUrl);
        // Anyone who can reach an open Redis can enqueue jobs and read queue contents: a non-loopback Redis
        // must demand a password unless the owner says the path is private.
        if (
          !isLoopbackHost(u.hostname) &&
          !u.password &&
          !bool('REDIS_ALLOW_UNAUTHENTICATED', false)
        ) {
          issues.push(
            'REDIS_URL: points to a non-loopback host without a password; use redis://:password@host:port, ' +
              'or set REDIS_ALLOW_UNAUTHENTICATED=true if the path is private and trusted',
          );
        }
      } catch {
        issues.push('REDIS_URL: is not a valid URL');
      }
    }
  }

  const env: Env = {
    nodeEnv: nodeEnv ?? 'development',
    port: int('PORT', 3000, 1, 65535),
    host,
    allowRemoteBind,
    appName: str(raw, 'APP_NAME') ?? 'finance-bot',
    timezone: str(raw, 'TZ') ?? 'Asia/Jakarta',
    logLevel: str(raw, 'LOG_LEVEL') ?? 'info',
    logPretty: bool('LOG_PRETTY', false),
    databaseUrl,
    telegram: {
      botToken,
      polling,
      webhookSecret,
      allowedUserIds,
      allowPublic,
      userRateLimitPerMinute: int('USER_RATE_LIMIT_PER_MINUTE', 30, 1, 10_000),
    },
    ai: {
      provider: aiProvider ?? 'ollama',
      ollamaBaseUrl: ollamaBaseUrl.replace(/\/+$/, ''),
      ollamaModel: str(raw, 'OLLAMA_MODEL') ?? '',
      timeoutMs: int('OLLAMA_TIMEOUT_MS', 120_000, 1_000, 900_000),
      maxResponseBytes: int('OLLAMA_MAX_RESPONSE_BYTES', 1_048_576, 1_024, 33_554_432),
      breakerFailures: int('OLLAMA_BREAKER_FAILURES', 3, 1, 100),
      breakerCooldownMs: int('OLLAMA_BREAKER_COOLDOWN_SECONDS', 30, 1, 3_600) * 1_000,
    },
    receipt: {
      maxFileSizeBytes: int('RECEIPT_MAX_FILE_SIZE_BYTES', 5_242_880, 10_240, 20_971_520),
      maxPixels: int('RECEIPT_MAX_PIXELS', 25_000_000, 100_000, 100_000_000),
      pendingTtlMinutes: int('RECEIPT_PENDING_TTL_MINUTES', 30, 1, 1_440),
      maxPerHour: int('RECEIPT_MAX_PER_HOUR', 20, 1, 1_000),
      aiMode: aiMode ?? 'auto',
    },
    swagger: { enabled: swaggerEnabled, path: str(raw, 'SWAGGER_PATH') ?? 'docs' },
    limits: { maxInputChars: int('MAX_INPUT_CHARS', 2_000, 100, 4_096) },
    queue: {
      redisUrl,
      connectTimeoutMs: int('REDIS_CONNECT_TIMEOUT_MS', 2_000, 100, 30_000),
      keyPrefix,
      receiptConcurrency: int('RECEIPT_WORKER_CONCURRENCY', 1, 1, 4),
      receiptAttempts: int('RECEIPT_JOB_ATTEMPTS', 3, 1, 10),
      receiptBackoffMs: int('RECEIPT_JOB_BACKOFF_SECONDS', 5, 1, 300) * 1_000,
      receiptTimeoutMs: int('RECEIPT_JOB_TIMEOUT_SECONDS', 300, 10, 900) * 1_000,
    },
    retention: {
      intervalHours: int('RETENTION_INTERVAL_HOURS', 6, 1, 168),
      receiptDraftDays: int('RECEIPT_DRAFT_RETENTION_DAYS', 30, 0, 3_650),
      auditDays: int('AUDIT_RETENTION_DAYS', 365, 0, 3_650),
    },
  };

  // Checked after every value was read, so numeric/boolean problems are reported too.
  if (issues.length > 0) throw new EnvValidationError(issues);
  return env;
}
