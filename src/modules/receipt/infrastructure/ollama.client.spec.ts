import { FakeOllama } from 'src/testing/fake-ollama';
import { OllamaClient, OllamaUnavailableError } from './ollama.client';

const settings = (
  baseUrl: string,
  over: Partial<{
    ollamaModel: string;
    timeoutMs: number;
    maxResponseBytes: number;
    provider: 'ollama' | 'none';
    breakerFailures: number;
    breakerCooldownMs: number;
  }> = {},
) => ({
  provider: 'ollama' as const,
  ollamaBaseUrl: baseUrl,
  ollamaModel: '',
  timeoutMs: 2_000,
  maxResponseBytes: 4_096,
  ...over,
});

const TEXT_MODEL = { name: 'some-text-model:1b', capabilities: ['completion'] };
const VISION_MODEL = { name: 'some-vision-model:7b', capabilities: ['completion', 'vision'] };
const EMBED_MODEL = { name: 'embedder:1b', capabilities: ['embedding'] };

describe('OllamaClient circuit breaker', () => {
  let fake: FakeOllama;
  afterEach(async () => fake?.stop());
  const chat = (client: OllamaClient) =>
    client.chatJson({ model: 'some-text-model:1b', system: 's', user: 'u', schema: {} });
  const chatCalls = () => fake.requests.filter((r) => r.path === '/api/chat').length;

  it('stops calling a server that keeps failing, and answers at once instead of waiting', async () => {
    fake = new FakeOllama({ models: [TEXT_MODEL], chatStatus: 500 });
    await fake.start();
    const client = new OllamaClient(
      settings(fake.baseUrl, { breakerFailures: 2, breakerCooldownMs: 60_000 }),
    );
    await expect(chat(client)).rejects.toBeInstanceOf(OllamaUnavailableError);
    await expect(chat(client)).rejects.toBeInstanceOf(OllamaUnavailableError);
    expect(client.breaker.state).toBe('OPEN');
    const before = chatCalls();
    const started = Date.now();
    await expect(chat(client)).rejects.toMatchObject({ reason: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(100);
    expect(chatCalls()).toBe(before); // no request reached the server
  });

  // Regression: listing the models succeeds while chatting keeps failing (e.g. out of memory). The
  // real extractor does resolveModel() then chatJson(); the successful first step must not keep the
  // breaker shut.
  it('opens when chat keeps failing even though the model listing keeps succeeding', async () => {
    fake = new FakeOllama({ models: [TEXT_MODEL], chatStatus: 500 });
    await fake.start();
    const client = new OllamaClient(
      settings(fake.baseUrl, { breakerFailures: 2, breakerCooldownMs: 60_000 }),
    );
    for (let i = 0; i < 2; i += 1) {
      const model = await client.resolveModel(); // succeeds every time
      await expect(
        client.chatJson({ model, system: 's', user: 'u', schema: {} }),
      ).rejects.toBeInstanceOf(OllamaUnavailableError);
    }
    expect(client.breaker.state).toBe('OPEN');
    const started = Date.now();
    await expect(client.resolveModel()).rejects.toMatchObject({ reason: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('lets one probe through after the cooldown and closes again when it works', async () => {
    fake = new FakeOllama({ models: [TEXT_MODEL], chatStatus: 500 });
    await fake.start();
    const client = new OllamaClient(
      settings(fake.baseUrl, { breakerFailures: 1, breakerCooldownMs: 50 }),
    );
    await expect(chat(client)).rejects.toBeInstanceOf(OllamaUnavailableError);
    expect(client.breaker.state).toBe('OPEN');

    fake.options.chatStatus = undefined;
    fake.options.chatReply = '{"ok":true}';
    await new Promise((r) => setTimeout(r, 80));
    await expect(chat(client)).resolves.toBe('{"ok":true}');
    expect(client.breaker.state).toBe('CLOSED');
  });

  it('a reachable server with no usable model is ALIVE: it never opens the breaker', async () => {
    fake = new FakeOllama({ models: [EMBED_MODEL] }); // nothing that can complete text
    await fake.start();
    const client = new OllamaClient(
      settings(fake.baseUrl, { breakerFailures: 1, breakerCooldownMs: 60_000 }),
    );
    for (let i = 0; i < 4; i += 1) {
      await expect(client.resolveModel()).rejects.toMatchObject({ reason: 'no_model' });
    }
    expect(client.breaker.state).toBe('CLOSED');
  });

  it('an unreachable server opens the breaker, and the health probe stops hammering it', async () => {
    const client = new OllamaClient(
      settings('http://127.0.0.1:1', { breakerFailures: 1, breakerCooldownMs: 60_000 }),
    );
    expect((await client.check()).available).toBe(false);
    expect(client.breaker.state).toBe('OPEN');
    const status = await client.check();
    expect(status.available).toBe(false);
    expect(status.detail).toMatch(/paused/i);
  });

  it('AI disabled is not a failure and never touches the breaker', async () => {
    const client = new OllamaClient(settings('http://127.0.0.1:1', { provider: 'none' }));
    await expect(client.resolveModel()).rejects.toMatchObject({ reason: 'disabled' });
    expect(client.breaker.state).toBe('CLOSED');
  });
});

describe('OllamaClient (against a fake server)', () => {
  let fake: FakeOllama;
  afterEach(async () => fake?.stop());

  const start = async (options: ConstructorParameters<typeof FakeOllama>[0]) => {
    fake = new FakeOllama(options);
    await fake.start();
    return fake;
  };

  it('picks the first installed model that can complete text (never a hard-coded name)', async () => {
    await start({ models: [EMBED_MODEL, TEXT_MODEL] });
    const client = new OllamaClient(settings(fake.baseUrl));
    await expect(client.resolveModel()).resolves.toBe('some-text-model:1b');
  });

  it('uses the configured model when installed, and fails clearly when it is not', async () => {
    await start({ models: [TEXT_MODEL] });
    await expect(
      new OllamaClient(
        settings(fake.baseUrl, { ollamaModel: 'some-text-model:1b' }),
      ).resolveModel(),
    ).resolves.toBe('some-text-model:1b');
    await expect(
      new OllamaClient(settings(fake.baseUrl, { ollamaModel: 'missing:1b' })).resolveModel(),
    ).rejects.toMatchObject({ reason: 'no_model' });
  });

  it('reads vision support from the model, not from its name', async () => {
    await start({
      models: [{ name: 'llava-looking-name', capabilities: ['completion'] }, VISION_MODEL],
    });
    const client = new OllamaClient(settings(fake.baseUrl));
    expect(await client.supportsVision('llava-looking-name')).toBe(false);
    expect(await client.supportsVision('some-vision-model:7b')).toBe(true);
  });

  it('refuses to send images to a model without the vision capability', async () => {
    await start({ models: [TEXT_MODEL] });
    const client = new OllamaClient(settings(fake.baseUrl));
    await expect(
      client.chatJson({
        model: 'some-text-model:1b',
        system: 's',
        user: 'u',
        schema: {},
        imagesBase64: ['AAAA'],
      }),
    ).rejects.toMatchObject({ reason: 'unsupported' });
    expect(fake.requests.some((r) => r.path === '/api/chat')).toBe(false);
  });

  it('asks for deterministic JSON output and disables thinking only when the model has it', async () => {
    await start({
      models: [{ name: 'think:1b', capabilities: ['completion', 'thinking'] }, TEXT_MODEL],
      chatReply: '{"ok":true}',
    });
    const client = new OllamaClient(settings(fake.baseUrl));
    await client.chatJson({
      model: 'think:1b',
      system: 's',
      user: 'u',
      schema: { type: 'object' },
    });
    await client.chatJson({
      model: 'some-text-model:1b',
      system: 's',
      user: 'u',
      schema: { type: 'object' },
    });
    const chats = fake.requests.filter((r) => r.path === '/api/chat').map((r) => r.body!);
    expect(chats[0]).toMatchObject({
      stream: false,
      think: false,
      format: { type: 'object' },
      options: { temperature: 0 },
    });
    expect(chats[1]).not.toHaveProperty('think');
  });

  it('bounds the size of the model response', async () => {
    await start({ models: [TEXT_MODEL], chatReply: 'x'.repeat(50_000) });
    const client = new OllamaClient(settings(fake.baseUrl, { maxResponseBytes: 2_048 }));
    await expect(
      client.chatJson({ model: 'some-text-model:1b', system: 's', user: 'u', schema: {} }),
    ).rejects.toBeInstanceOf(OllamaUnavailableError);
  });

  it('serves only one model request at a time (a model gains nothing from parallel ones)', async () => {
    await start({ models: [TEXT_MODEL], chatReply: '{}', chatDelayMs: 60 });
    const client = new OllamaClient(settings(fake.baseUrl));
    const call = () =>
      client.chatJson({ model: 'some-text-model:1b', system: 's', user: 'u', schema: {} });
    await Promise.all([call(), call(), call(), call()]);
    expect(fake.chatMaxActive).toBe(1);
    expect(fake.requests.filter((r) => r.path === '/api/chat')).toHaveLength(4);
  });

  it('a failing request does not keep the next one waiting', async () => {
    await start({ models: [TEXT_MODEL], chatStatus: 500 });
    const client = new OllamaClient(settings(fake.baseUrl));
    const call = () =>
      client.chatJson({ model: 'some-text-model:1b', system: 's', user: 'u', schema: {} });
    await expect(call()).rejects.toBeInstanceOf(OllamaUnavailableError);
    delete fake.options.chatStatus;
    fake.options.chatReply = '{}';
    await expect(call()).resolves.toBe('{}');
  });

  it('times out instead of hanging when the model never answers', async () => {
    await start({ models: [TEXT_MODEL], chatHang: true });
    const client = new OllamaClient(settings(fake.baseUrl, { timeoutMs: 300 }));
    const started = Date.now();
    await expect(
      client.chatJson({ model: 'some-text-model:1b', system: 's', user: 'u', schema: {} }),
    ).rejects.toMatchObject({ reason: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('maps a server error to "unavailable" without leaking the body', async () => {
    await start({ models: [TEXT_MODEL], chatStatus: 500 });
    const client = new OllamaClient(settings(fake.baseUrl));
    await expect(
      client.chatJson({ model: 'some-text-model:1b', system: 's', user: 'u', schema: {} }),
    ).rejects.toThrow('AI unavailable');
  });

  describe('readiness probe', () => {
    it('is available with a usable model', async () => {
      await start({ models: [TEXT_MODEL] });
      expect(await new OllamaClient(settings(fake.baseUrl)).check()).toEqual({ available: true });
    });

    it('reports a missing model with a fixed message', async () => {
      await start({ models: [EMBED_MODEL] });
      const status = await new OllamaClient(settings(fake.baseUrl)).check();
      expect(status.available).toBe(false);
      expect(status.detail).toMatch(/no usable model/);
    });

    it('reports an unreachable server without any URL in the message', async () => {
      const client = new OllamaClient(settings('http://127.0.0.1:1')); // nothing listens on port 1
      const status = await client.check();
      expect(status).toEqual({ available: false, detail: 'Ollama is not reachable' });
    });

    it('is simply off when AI_PROVIDER=none', async () => {
      const client = new OllamaClient(settings('http://127.0.0.1:1', { provider: 'none' }));
      expect(client.enabled).toBe(false);
      expect((await client.check()).available).toBe(false);
      await expect(client.resolveModel()).rejects.toMatchObject({ reason: 'disabled' });
    });
  });
});
