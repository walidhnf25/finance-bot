import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from 'src/modules/observability/metrics.service';
import {
  fetchWithTimeout,
  readBytesBounded,
  readJsonBounded,
  TransientHttpError,
  withRetry,
} from 'src/common/http/http';
import { IncomingMessageHandler, MessagingGateway } from '../domain/messaging.gateway.port';
import { toIncomingMessage } from './telegram-update.mapper';
import { TelegramUpdate } from './telegram.types';

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Errors never carry the request URL (it contains the bot token). */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number | undefined,
    description: string | undefined,
  ) {
    super(`Telegram ${method} failed (${errorCode ?? 'n/a'}): ${description ?? 'unknown error'}`);
  }
}

/** Telegram JSON replies are small; this bounds a misbehaving server. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const SEND_TIMEOUT_MS = 15_000;
const DOCUMENT_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** getUpdates long-polls on the server; the client timeout must outlast it. */
const POLL_MARGIN_MS = 10_000;
const RETRY = { attempts: 3, baseMs: 500, maxMs: 8_000 } as const;

/**
 * Telegram Bot API adapter. Stateless: inbound updates are pushed in by the webhook controller or
 * the poller via {@link handleUpdate}. Every call has an explicit timeout; transient
 * failures (network, timeout, 429 with `retry_after`, 5xx) are retried a bounded number of times.
 */
@Injectable()
export class TelegramGateway extends MessagingGateway {
  private readonly logger = new Logger(TelegramGateway.name);
  private readonly apiBase: string;
  private readonly fileBase: string;
  private readonly allowedUserIds: Set<string>;
  private readonly allowPublic: boolean;
  private handler: IncomingMessageHandler | null = null;

  constructor(
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
    const token = config.getOrThrow<string>('telegram.botToken');
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
    this.allowedUserIds = new Set(config.get<string[]>('telegram.allowedUserIds', []));
    this.allowPublic = config.get<boolean>('telegram.allowPublic', false);
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handler = handler;
  }

  /**
   * Fail closed: a message is processed only when the sender is on the allowlist, or the bot was
   * explicitly configured as public. (Startup validation already rejects "no list and not public".)
   */
  isAuthorized(userId: string): boolean {
    if (this.allowedUserIds.size > 0) return this.allowedUserIds.has(userId);
    return this.allowPublic;
  }

  /** Normalize an update and run the inbound handler on it (awaited). */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = toIncomingMessage(update);
    if (!message || !this.handler) return;

    if (!this.isAuthorized(message.from)) {
      this.logger.warn('Message from a user that is not authorized; ignored');
      this.metrics?.inc('updates_unauthorized_total');
      return;
    }

    await this.handler(message);
  }

  /**
   * Replies use Telegram's legacy Markdown (`*bold*`, `_italic_`). Text echoed from the user can
   * contain unbalanced `*` or `_`, so a 400 parse failure falls back to plain text.
   */
  async sendText(to: string, text: string): Promise<void> {
    try {
      await this.call('sendMessage', { chat_id: to, text, parse_mode: 'Markdown' });
    } catch (err) {
      if (err instanceof TelegramApiError && err.errorCode === 400) {
        await this.call('sendMessage', { chat_id: to, text });
        return;
      }
      throw err;
    }
  }

  async sendDocument(
    to: string,
    content: Buffer,
    filename: string,
    mimetype = 'application/octet-stream',
  ): Promise<void> {
    await this.request<unknown>(
      'sendDocument',
      () => {
        const form = new FormData();
        form.append('chat_id', to);
        form.append('document', new Blob([new Uint8Array(content)], { type: mimetype }), filename);
        return { method: 'POST', body: form };
      },
      DOCUMENT_TIMEOUT_MS,
    );
  }

  /** Download a user's file (receipt photo), never reading more than `maxBytes`. */
  async downloadFile(fileId: string, maxBytes: number): Promise<Buffer> {
    const info = await this.call<{ file_path?: string; file_size?: number }>('getFile', {
      file_id: fileId,
    });
    if (!info.file_path) throw new TelegramApiError('getFile', undefined, 'no file path');
    if (info.file_size !== undefined && info.file_size > maxBytes) {
      throw new TelegramApiError('getFile', undefined, 'file too large');
    }

    return this.downloadWithRetry(info.file_path, maxBytes);
  }

  private async downloadWithRetry(filePath: string, maxBytes: number): Promise<Buffer> {
    try {
      return await this.fetchFileBytes(filePath, maxBytes);
    } catch (err) {
      this.metrics?.inc('telegram_errors_total', { kind: 'download' });
      throw err;
    }
  }

  private fetchFileBytes(filePath: string, maxBytes: number): Promise<Buffer> {
    return withRetry(async () => {
      const res = await fetchWithTimeout(`${this.fileBase}/${filePath}`, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      if (!res.ok) {
        if (res.status >= 500) throw new TransientHttpError('Telegram file download failed');
        throw new TelegramApiError('downloadFile', res.status, 'download rejected');
      }
      return readBytesBounded(res, maxBytes);
    }, RETRY);
  }

  /** Long-poll for updates (the default run mode). */
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.request<TelegramUpdate[]>(
      'getUpdates',
      () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          offset,
          timeout: timeoutSeconds,
          allowed_updates: ['message'],
        }),
      }),
      timeoutSeconds * 1000 + POLL_MARGIN_MS,
    );
  }

  private call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(
      method,
      () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      SEND_TIMEOUT_MS,
    );
  }

  private async request<T>(method: string, init: () => RequestInit, timeoutMs: number): Promise<T> {
    try {
      return await this.requestWithRetry<T>(method, init, timeoutMs);
    } catch (err) {
      const kind = method === 'getUpdates' ? 'poll' : method === 'getFile' ? 'download' : 'send';
      this.metrics?.inc('telegram_errors_total', { kind });
      throw err;
    }
  }

  private requestWithRetry<T>(
    method: string,
    init: () => RequestInit,
    timeoutMs: number,
  ): Promise<T> {
    return withRetry(async () => {
      const res = await fetchWithTimeout(`${this.apiBase}/${method}`, {
        ...init(),
        timeoutMs,
      });
      const body = await readJsonBounded<TelegramResponse<T>>(res, MAX_JSON_BYTES);
      if (body.ok) return body.result as T;

      const code = body.error_code;
      if (code === 429 || (code !== undefined && code >= 500)) {
        throw new TransientHttpError(
          `Telegram ${method} temporarily failed (${code})`,
          (body.parameters?.retry_after ?? 0) * 1000,
        );
      }
      throw new TelegramApiError(method, code, body.description);
    }, RETRY);
  }
}
