import { AuditLogRepository } from 'src/modules/audit/domain/audit-log.repository';
import { CreateUserInput, UserEntity } from 'src/modules/user/domain/user.entity';
import { UserRepository } from 'src/modules/user/domain/user.repository';
import {
  IncomingMessage,
  IncomingMessageHandler as GatewayHandler,
  MessagingGateway,
} from '../domain/messaging.gateway.port';
import { SlidingWindowLimiter } from 'src/common/utils/rate-limiter';
import { IncomingMessageHandler } from './incoming-message.handler';
import { MessageDedupeService } from './message-dedupe.service';
import { MessageOrchestrator } from './message-orchestrator';
import { ReplyBuilder } from './reply-builder';

class FakeGateway extends MessagingGateway {
  sent: Array<{ to: string; text: string }> = [];
  onMessage(_handler: GatewayHandler): void {}
  sendText(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
    return Promise.resolve();
  }
  sendDocument(): Promise<void> {
    return Promise.resolve();
  }
  downloadFile(): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(0));
  }
}

class StubUserRepository extends UserRepository {
  readonly known = new Map<string, UserEntity>();
  findById(): Promise<UserEntity | null> {
    return Promise.resolve(null);
  }
  findByTelegramId(telegramId: string): Promise<UserEntity | null> {
    return Promise.resolve(this.known.get(telegramId) ?? null);
  }
  findOrCreate(input: CreateUserInput): Promise<{ user: UserEntity; created: boolean }> {
    const existing = this.known.get(input.telegramId);
    if (existing) return Promise.resolve({ user: existing, created: false });
    const user: UserEntity = {
      id: `id-${input.telegramId}`,
      telegramId: input.telegramId,
      chatId: input.chatId ?? null,
      displayName: input.displayName ?? null,
      currency: 'IDR',
      timezone: 'Asia/Jakarta',
      isOnboarded: false,
      walletMode: null,
      defaultWallet: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.known.set(input.telegramId, user);
    return Promise.resolve({ user, created: true });
  }
  update(): Promise<UserEntity> {
    throw new Error('not used');
  }
}

class StubAuditRepository extends AuditLogRepository {
  actions: string[] = [];
  events: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  record(input: { action: string; metadata?: Record<string, unknown> }): Promise<void> {
    this.events.push(input);
    this.actions.push(input.action);
    return Promise.resolve();
  }
  findForUser(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

function msg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `m-${Math.round(Math.random() * 1e9)}`,
    from: '628123',
    chatId: '628123',
    text: 'beli kopi 25rb',
    senderName: 'Budi',
    timestamp: new Date('2026-07-15T03:00:00.000Z'),
    ...overrides,
  };
}

describe('IncomingMessageHandler', () => {
  let gateway: FakeGateway;
  let users: StubUserRepository;
  let audit: StubAuditRepository;
  let orchestrator: { process: jest.Mock; walletSetupPrompt: jest.Mock };
  let handler: IncomingMessageHandler;
  let dedupe: MessageDedupeService;
  let limiter: SlidingWindowLimiter;

  beforeEach(() => {
    gateway = new FakeGateway();
    users = new StubUserRepository();
    audit = new StubAuditRepository();
    dedupe = new MessageDedupeService();
    limiter = new SlidingWindowLimiter(1000, 60_000);
    orchestrator = {
      process: jest.fn().mockResolvedValue({ text: 'ROUTED_REPLY' }),
      walletSetupPrompt: jest.fn().mockResolvedValue(null),
    };
    handler = new IncomingMessageHandler(
      gateway,
      users,
      audit,
      dedupe,
      new ReplyBuilder(),
      orchestrator as unknown as MessageOrchestrator,
      limiter,
    );
  });

  it('onboards a new user and sends the orchestrated reply', async () => {
    await handler.handle(msg({ messageId: 'm1' }));
    expect(gateway.sent).toHaveLength(2);
    expect(gateway.sent[0].text).toContain('Selamat datang');
    expect(gateway.sent[1].text).toBe('ROUTED_REPLY');
    expect(audit.actions).toEqual(['MESSAGE_IN', 'MESSAGE_OUT']);
  });

  it('asks a new user which wallets to use after the first reply', async () => {
    orchestrator.walletSetupPrompt.mockResolvedValue('WALLET_QUESTION');
    await handler.handle(msg({ messageId: 'm1' }));

    expect(gateway.sent.map((s) => s.text)).toEqual([
      expect.stringContaining('Selamat datang'),
      'ROUTED_REPLY',
      'WALLET_QUESTION',
    ]);
  });

  it('skips the wallet question when a follow-up is already pending', async () => {
    orchestrator.walletSetupPrompt.mockResolvedValue(null);
    await handler.handle(msg({ messageId: 'm1' }));
    expect(gateway.sent).toHaveLength(2);
  });

  describe('retries and duplicates', () => {
    it('ignores a message that was already handled successfully', async () => {
      await handler.handle(msg({ messageId: 'dup' }));
      orchestrator.process.mockClear();
      await handler.handle(msg({ messageId: 'dup' }));
      expect(orchestrator.process).not.toHaveBeenCalled();
    });

    it('does NOT mark a failed message as handled, so its redelivery is processed again', async () => {
      orchestrator.process.mockRejectedValueOnce(new Error('database is down'));
      await expect(handler.handle(msg({ messageId: 'retry-me' }))).rejects.toThrow(
        'database is down',
      );

      orchestrator.process.mockResolvedValue({ text: 'OK_NOW' });
      await handler.handle(msg({ messageId: 'retry-me' }));
      expect(gateway.sent.some((s) => s.text === 'OK_NOW')).toBe(true);
    });
  });

  describe('rate limiting', () => {
    it('answers once with a calm warning and drops the rest of the window', async () => {
      limiter = new SlidingWindowLimiter(2, 60_000);
      handler = new IncomingMessageHandler(
        gateway,
        users,
        audit,
        dedupe,
        new ReplyBuilder(),
        orchestrator as unknown as MessageOrchestrator,
        limiter,
      );
      for (let i = 0; i < 6; i++) await handler.handle(msg({ messageId: `r${i}` }));

      expect(orchestrator.process).toHaveBeenCalledTimes(2);
      expect(gateway.sent.filter((s) => s.text.includes('Pelan-pelan'))).toHaveLength(1);
    });

    it('limits per sender, not globally', async () => {
      limiter = new SlidingWindowLimiter(1, 60_000);
      handler = new IncomingMessageHandler(
        gateway,
        users,
        audit,
        dedupe,
        new ReplyBuilder(),
        orchestrator as unknown as MessageOrchestrator,
        limiter,
      );
      await handler.handle(msg({ messageId: 'a1', from: '1', chatId: '1' }));
      await handler.handle(msg({ messageId: 'a2', from: '1', chatId: '1' }));
      await handler.handle(msg({ messageId: 'b1', from: '2', chatId: '2' }));
      expect(orchestrator.process).toHaveBeenCalledTimes(2); // one for sender 1, one for sender 2
    });
  });

  describe('privacy', () => {
    it('audits sizes and types, never the message text', async () => {
      await handler.handle(msg({ messageId: 'p1', text: 'beli rahasia-kopi 77777rb' }));
      const incoming = audit.events.find((e) => e.action === 'MESSAGE_IN')!;
      expect(JSON.stringify(incoming)).not.toContain('rahasia');
      expect(JSON.stringify(incoming)).not.toContain('77777');
      expect(incoming.metadata).toEqual({
        length: 'beli rahasia-kopi 77777rb'.length,
        hasImage: false,
      });
    });

    it('notes when an image was attached', async () => {
      await handler.handle(
        msg({ messageId: 'p2', text: '', attachment: { kind: 'image', fileId: 'f' } }),
      );
      expect(audit.events.find((e) => e.action === 'MESSAGE_IN')!.metadata).toMatchObject({
        hasImage: true,
      });
    });
  });

  it('never asks returning users', async () => {
    await handler.handle(msg({ messageId: 'm1' }));
    await handler.handle(msg({ messageId: 'm2' }));
    expect(orchestrator.walletSetupPrompt).toHaveBeenCalledTimes(1);
  });

  it('sends nothing (and no MESSAGE_OUT) when the orchestrator returns empty', async () => {
    orchestrator.process.mockResolvedValue({});
    await handler.handle(msg({ messageId: 'm1', text: 'halo' }));
    expect(gateway.sent).toHaveLength(1); // onboarding only
    expect(audit.actions).toEqual(['MESSAGE_IN']);
  });

  it('ignores duplicate message ids', async () => {
    await handler.handle(msg({ messageId: 'dup' }));
    const count = gateway.sent.length;
    await handler.handle(msg({ messageId: 'dup' }));
    expect(gateway.sent.length).toBe(count);
  });
});
