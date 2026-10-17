/**
 * Small, dependency-free HTTP safety helpers used for every outbound call (Telegram, Ollama):
 * explicit timeouts, bounded retries with backoff + jitter, and bounded response reading.
 * Nothing here ever includes a URL, header or body in an error message (they can hold tokens).
 */

export class HttpTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`HTTP request timed out after ${timeoutMs}ms`);
    this.name = 'HttpTimeoutError';
  }
}

export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`HTTP response exceeded ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/** A transient failure that a retry may fix (network error, timeout, 429, 5xx). */
export class TransientHttpError extends Error {
  constructor(
    message: string,
    /** Server-requested wait (e.g. Telegram `retry_after`), in milliseconds. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TransientHttpError';
  }
}

/**
 * `fetch` that is aborted after `timeoutMs`. The abort also cancels reading the body, so a server
 * that sends headers and then stalls cannot hang the caller. Network failures are rethrown as
 * {@link TransientHttpError} without the original (URL-bearing) message.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, {
      ...rest,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (timeout.aborted) throw new HttpTimeoutError(timeoutMs);
    if (signal?.aborted) throw err;
    throw new TransientHttpError('HTTP request failed (network error)');
  }
}

/**
 * Read a response body as text but stop (and cancel the stream) as soon as it exceeds `maxBytes`,
 * so a misbehaving server cannot make the process buffer an unbounded body.
 */
export async function readTextBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!res.body) return '';

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJsonBounded<T>(res: Response, maxBytes: number): Promise<T> {
  const text = await readTextBounded(res, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TransientHttpError('HTTP response was not valid JSON');
  }
}

/** Read raw bytes with the same bound (used for downloaded images). */
export async function readBytesBounded(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export interface RetryOptions {
  /** Total tries including the first one. */
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Which errors are worth retrying. Defaults to transient/timeout errors only. */
  shouldRetry?: (err: unknown) => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; returns a value in [0, 1). */
  random?: () => number;
}

const defaultShouldRetry = (err: unknown): boolean =>
  err instanceof TransientHttpError || err instanceof HttpTimeoutError;

/**
 * Run `fn`, retrying transient failures with exponential backoff and up to 25% jitter. Retries
 * stay bounded (`attempts`), honour a server-provided `retryAfterMs`, and never retry errors the
 * caller did not mark as retryable. Do NOT wrap non-idempotent writes unless the operation
 * carries an idempotency key.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= options.attempts || !shouldRetry(err)) throw err;
      const backoff = Math.min(options.maxMs, options.baseMs * 2 ** (attempt - 1));
      const requested = err instanceof TransientHttpError ? (err.retryAfterMs ?? 0) : 0;
      const delay = Math.min(options.maxMs, Math.max(backoff, requested)) * (1 + random() * 0.25);
      await sleep(Math.round(delay));
    }
  }
}
