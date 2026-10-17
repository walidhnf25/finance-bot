import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';

export interface FakeModel {
  name: string;
  capabilities: string[];
}

export interface FakeOllamaOptions {
  models: FakeModel[];
  /** What `/api/chat` answers with (the raw message content). */
  chatReply?: string | ((body: Record<string, unknown>) => string);
  /** Respond with this HTTP status to /api/chat instead. */
  chatStatus?: number;
  /** Never answer /api/chat (to exercise timeouts). */
  chatHang?: boolean;
  /** Hold every /api/chat answer for this long (to observe concurrency). */
  chatDelayMs?: number;
}

/** A tiny in-process stand-in for the Ollama HTTP API, for tests only. */
export class FakeOllama {
  readonly requests: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  /** Chat requests being served right now, and the most that were ever served at once. */
  chatActive = 0;
  chatMaxActive = 0;
  private server: Server | null = null;
  baseUrl = '';

  constructor(public options: FakeOllamaOptions) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const path = req.url ?? '';
    this.requests.push({ path, body });

    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (path === '/api/tags')
      return json(200, { models: this.options.models.map((m) => ({ name: m.name })) });
    if (path === '/api/show') {
      const model = this.options.models.find((m) => m.name === body?.model);
      return model
        ? json(200, { capabilities: model.capabilities })
        : json(404, { error: 'not found' });
    }
    if (path === '/api/chat') {
      if (this.options.chatHang) return;
      this.chatActive += 1;
      this.chatMaxActive = Math.max(this.chatMaxActive, this.chatActive);
      if (this.options.chatDelayMs)
        await new Promise((r) => setTimeout(r, this.options.chatDelayMs));
      this.chatActive -= 1;
      if (this.options.chatStatus) return json(this.options.chatStatus, { error: 'boom' });
      const reply = this.options.chatReply ?? '{}';
      const content = typeof reply === 'function' ? reply(body ?? {}) : reply;
      return json(200, { message: { role: 'assistant', content } });
    }
    json(404, {});
  }
}
