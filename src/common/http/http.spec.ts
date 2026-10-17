import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  fetchWithTimeout,
  HttpTimeoutError,
  readBytesBounded,
  readJsonBounded,
  readTextBounded,
  ResponseTooLargeError,
  TransientHttpError,
  withRetry,
} from './http';

/** A real HTTP server on loopback, so timeouts and body limits are exercised for real. */
describe('http helpers (real loopback server)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      switch (req.url) {
        case '/stall': // never answers
          return;
        case '/stall-body': // sends headers, then stalls forever
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('partial');
          return;
        case '/big-chunked': // no content-length, endless body
          res.writeHead(200);
          res.write('x'.repeat(4096));
          res.write('y'.repeat(4096));
          res.end('z'.repeat(4096));
          return;
        case '/big-declared':
          res.writeHead(200, { 'content-length': '999999' });
          res.end('a');
          return;
        case '/json':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          return;
        case '/not-json':
          res.writeHead(200);
          res.end('<html>nope</html>');
          return;
        default:
          res.writeHead(404);
          res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('fetchWithTimeout', () => {
    it('aborts a request that never answers', async () => {
      const started = Date.now();
      await expect(fetchWithTimeout(`${base}/stall`, { timeoutMs: 150 })).rejects.toBeInstanceOf(
        HttpTimeoutError,
      );
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('also bounds a server that sends headers and then stalls the body', async () => {
      const res = await fetchWithTimeout(`${base}/stall-body`, { timeoutMs: 200 });
      await expect(readTextBounded(res, 1024)).rejects.toThrow();
    });

    it('returns the response when it is fast enough', async () => {
      const res = await fetchWithTimeout(`${base}/json`, { timeoutMs: 2000 });
      expect(res.status).toBe(200);
    });

    it('turns a network failure into a transient error that does not leak the URL', async () => {
      const error = await fetchWithTimeout('http://127.0.0.1:1/secret-token-path', {
        timeoutMs: 1000,
      }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(TransientHttpError);
      expect((error as Error).message).not.toContain('secret-token-path');
      expect((error as Error).message).not.toContain('127.0.0.1');
    });

    it('honours a caller abort without calling it a timeout', async () => {
      const controller = new AbortController();
      const pending = fetchWithTimeout(`${base}/stall`, {
        timeoutMs: 5000,
        signal: controller.signal,
      });
      controller.abort();
      const error = await pending.catch((e: Error) => e);
      expect(error).not.toBeInstanceOf(HttpTimeoutError);
    });
  });

  describe('bounded reading', () => {
    it('rejects a body larger than the limit while streaming (no content-length)', async () => {
      const res = await fetchWithTimeout(`${base}/big-chunked`, { timeoutMs: 2000 });
      await expect(readTextBounded(res, 5000)).rejects.toBeInstanceOf(ResponseTooLargeError);
    });

    it('rejects up front when the announced length is already too large', async () => {
      const res = await fetchWithTimeout(`${base}/big-declared`, { timeoutMs: 2000 });
      await expect(readBytesBounded(res, 1000)).rejects.toBeInstanceOf(ResponseTooLargeError);
    });

    it('reads bodies within the limit, as text, JSON and bytes', async () => {
      expect(
        await readTextBounded(await fetchWithTimeout(`${base}/json`, { timeoutMs: 2000 }), 100),
      ).toBe('{"ok":true}');
      expect(
        await readJsonBounded(await fetchWithTimeout(`${base}/json`, { timeoutMs: 2000 }), 100),
      ).toEqual({ ok: true });
      expect(
        (await readBytesBounded(await fetchWithTimeout(`${base}/json`, { timeoutMs: 2000 }), 100))
          .length,
      ).toBe(11);
    });

    it('treats an unparsable body as a transient failure', async () => {
      const res = await fetchWithTimeout(`${base}/not-json`, { timeoutMs: 2000 });
      await expect(readJsonBounded(res, 1000)).rejects.toBeInstanceOf(TransientHttpError);
    });

    it('accepts a body of exactly the limit', async () => {
      const res = await fetchWithTimeout(`${base}/json`, { timeoutMs: 2000 });
      await expect(readTextBounded(res, 11)).resolves.toBe('{"ok":true}');
    });
  });
});

describe('withRetry', () => {
  const noSleep = { sleep: () => Promise.resolve(), random: () => 0 };

  it('returns the first success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    expect(await withRetry(fn, { attempts: 3, baseMs: 10, maxMs: 100, ...noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures up to the attempt limit, then rethrows', async () => {
    const fn = jest.fn().mockRejectedValue(new TransientHttpError('boom'));
    await expect(
      withRetry(fn, { attempts: 3, baseMs: 10, maxMs: 100, ...noSleep }),
    ).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('succeeds when a later attempt works', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new TransientHttpError('1'))
      .mockRejectedValueOnce(new HttpTimeoutError(5))
      .mockResolvedValue('finally');
    expect(await withRetry(fn, { attempts: 3, baseMs: 10, maxMs: 100, ...noSleep })).toBe(
      'finally',
    );
  });

  it('never retries an error it was not told is transient', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('invalid request'));
    await expect(
      withRetry(fn, { attempts: 5, baseMs: 10, maxMs: 100, ...noSleep }),
    ).rejects.toThrow('invalid request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff with bounded jitter, capped at maxMs', async () => {
    const delays: number[] = [];
    const fn = jest.fn().mockRejectedValue(new TransientHttpError('x'));
    await withRetry(fn, {
      attempts: 5,
      baseMs: 100,
      maxMs: 350,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5, // +12.5%
    }).catch(() => undefined);

    expect(delays).toEqual([112.5, 225, 393.75, 393.75].map(Math.round));
  });

  it('honours a server-requested wait (retry-after) but never beyond maxMs', async () => {
    const delays: number[] = [];
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new TransientHttpError('limited', 2000))
      .mockRejectedValueOnce(new TransientHttpError('limited', 999_999))
      .mockResolvedValue('ok');
    await withRetry(fn, {
      attempts: 3,
      baseMs: 10,
      maxMs: 5000,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      random: () => 0,
    });
    expect(delays).toEqual([2000, 5000]);
  });

  it('can be told which errors to retry', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValue('ok');
    expect(
      await withRetry(fn, {
        attempts: 2,
        baseMs: 1,
        maxMs: 1,
        shouldRetry: () => true,
        ...noSleep,
      }),
    ).toBe('ok');
  });
});
