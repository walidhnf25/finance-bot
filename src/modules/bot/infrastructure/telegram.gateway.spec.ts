import { ConfigService } from '@nestjs/config';
import { ResponseTooLargeError } from 'src/common/http/http';
import { TelegramApiError, TelegramGateway } from './telegram.gateway';
import { TelegramUpdate } from './telegram.types';

const TOKEN = '123456789:TEST-TOKEN-NOT-REAL-0123456789abcde';

function makeGateway(over: Record<string, unknown> = {}): TelegramGateway {
  const values: Record<string, unknown> = {
    'telegram.botToken': TOKEN,
    'telegram.allowedUserIds': ['1001'],
    'telegram.allowPublic': false,
    ...over,
  };
  const config = {
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService;
  return new TelegramGateway(config);
}

const ok = (result: unknown): Response =>
  new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const fail = (error_code: number, description: string, extra: object = {}): Response =>
  new Response(JSON.stringify({ ok: false, error_code, description, ...extra }), {
    status: error_code,
  });

const privateMessage = (userId: number, text = 'halo'): TelegramUpdate => ({
  update_id: 1,
  message: {
    message_id: 1,
    from: { id: userId, is_bot: false, first_name: 'X' },
    chat: { id: userId, type: 'private' },
    date: 1_784_000_000,
    text,
  },
});

type FetchCall = [string | URL, RequestInit];

describe('TelegramGateway', () => {
  let fetchMock: jest.SpyInstance;
  const callAt = (index: number): FetchCall => fetchMock.mock.calls[index] as FetchCall;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    // Make retries instant.
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as never);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('who may talk to the bot (fail closed)', () => {
    it('lets only allowlisted users through', async () => {
      const gateway = makeGateway();
      const handler = jest.fn().mockResolvedValue(undefined);
      gateway.onMessage(handler);

      await gateway.handleUpdate(privateMessage(2002));
      expect(handler).not.toHaveBeenCalled();
      await gateway.handleUpdate(privateMessage(1001));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('treats an empty allowlist as NO ONE unless the bot was explicitly made public', () => {
      const closed = makeGateway({ 'telegram.allowedUserIds': [], 'telegram.allowPublic': false });
      expect(closed.isAuthorized('1001')).toBe(false);

      const open = makeGateway({ 'telegram.allowedUserIds': [], 'telegram.allowPublic': true });
      expect(open.isAuthorized('1001')).toBe(true);
    });

    it('does not let "public" widen an explicit allowlist', () => {
      const gateway = makeGateway({
        'telegram.allowedUserIds': ['1001'],
        'telegram.allowPublic': true,
      });
      expect(gateway.isAuthorized('2002')).toBe(false);
    });

    it('ignores updates when no handler is registered', async () => {
      await expect(makeGateway().handleUpdate(privateMessage(1001))).resolves.toBeUndefined();
    });
  });

  describe('sending', () => {
    it('uses Markdown and sends to the right chat', async () => {
      fetchMock.mockResolvedValue(ok({}));
      await makeGateway().sendText('1001', '*halo*');

      const [url, init] = callAt(0);
      expect(String(url)).toContain('/sendMessage');
      expect(JSON.parse(init.body as string)).toEqual({
        chat_id: '1001',
        text: '*halo*',
        parse_mode: 'Markdown',
      });
    });

    it('falls back to plain text when Telegram cannot parse the Markdown (400)', async () => {
      fetchMock
        .mockResolvedValueOnce(fail(400, "can't parse entities"))
        .mockResolvedValueOnce(ok({}));
      await makeGateway().sendText('1001', 'a_b*c');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(callAt(1)[1].body as string)).not.toHaveProperty('parse_mode');
    });

    it('sends documents as multipart form data', async () => {
      fetchMock.mockResolvedValue(ok({}));
      await makeGateway().sendDocument(
        '1001',
        Buffer.from('xlsx-bytes'),
        'laporan.xlsx',
        'application/vnd.ms-excel',
      );

      const [url, init] = callAt(0);
      expect(String(url)).toContain('/sendDocument');
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get('chat_id')).toBe('1001');
    });
  });

  describe('timeouts and retries', () => {
    it('gives every request an abort signal (a timeout)', async () => {
      fetchMock.mockResolvedValue(ok({}));
      await makeGateway().sendText('1', 'x');
      expect(callAt(0)[1].signal).toBeInstanceOf(AbortSignal);
    });

    it('retries a rate-limit reply (429) and then succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(fail(429, 'Too Many Requests', { parameters: { retry_after: 1 } }))
        .mockResolvedValueOnce(ok({}));
      await makeGateway().sendText('1', 'x');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries server errors but stops after the attempt limit', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(fail(502, 'Bad Gateway')));
      await expect(makeGateway().sendText('1', 'x')).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries a network failure', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(ok({}));
      await makeGateway().sendText('1', 'x');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry a rejected request (e.g. chat not found)', async () => {
      fetchMock.mockResolvedValue(fail(403, 'Forbidden: bot was blocked by the user'));
      await expect(makeGateway().sendText('1', 'x')).rejects.toBeInstanceOf(TelegramApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('long-polls with a client timeout that outlasts the server-side wait', async () => {
      fetchMock.mockResolvedValue(ok([]));
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      await makeGateway().getUpdates(5, 25);
      expect(timeout).toHaveBeenCalledWith(35_000); // 25s long poll + 10s margin
      expect(JSON.parse(callAt(0)[1].body as string)).toMatchObject({
        offset: 5,
        timeout: 25,
      });
    });
  });

  describe('secrets never leak', () => {
    it('keeps the bot token out of error messages', async () => {
      fetchMock.mockRejectedValue(
        new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`),
      );
      const error = await makeGateway()
        .sendText('1', 'x')
        .catch((e: Error) => e);
      expect(String((error as Error).message)).not.toContain(TOKEN);

      fetchMock.mockResolvedValue(fail(403, 'Forbidden'));
      const apiError = await makeGateway()
        .sendText('1', 'x')
        .catch((e: Error) => e);
      expect(String((apiError as Error).message)).not.toContain(TOKEN);
    });
  });

  describe('downloading a receipt photo', () => {
    const fileResponse = (bytes: Buffer, headers: Record<string, string> = {}) =>
      new Response(new Uint8Array(bytes), { status: 200, headers });

    it('downloads the file via getFile and returns the bytes', async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ file_path: 'photos/file_1.jpg', file_size: 4 }))
        .mockResolvedValueOnce(fileResponse(Buffer.from('JPEG')));
      const bytes = await makeGateway().downloadFile('FILEID', 1000);

      expect(bytes.toString()).toBe('JPEG');
      expect(String(callAt(1)[0])).toContain('/file/bot');
      expect(String(callAt(1)[0])).toContain('photos/file_1.jpg');
    });

    it('refuses a file Telegram announces as too large, without downloading it', async () => {
      fetchMock.mockResolvedValueOnce(ok({ file_path: 'p.jpg', file_size: 9_000_000 }));
      await expect(makeGateway().downloadFile('F', 1000)).rejects.toBeInstanceOf(TelegramApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops reading when the real size exceeds the limit even if the announced size lied', async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ file_path: 'p.jpg', file_size: 10 }))
        .mockResolvedValueOnce(fileResponse(Buffer.alloc(5000, 1)));
      await expect(makeGateway().downloadFile('F', 1000)).rejects.toBeInstanceOf(
        ResponseTooLargeError,
      );
    });

    it('fails when Telegram gives no file path', async () => {
      fetchMock.mockResolvedValueOnce(ok({}));
      await expect(makeGateway().downloadFile('F', 1000)).rejects.toBeInstanceOf(TelegramApiError);
    });
  });
});
