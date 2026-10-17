import { MetricsService } from 'src/modules/observability/metrics.service';
import {
  JobQueue,
  QUEUE_NAMES,
  QueueUnavailableError,
  RejectedJobError,
} from 'src/modules/queue/domain/job-queue';
import { UserEntity } from 'src/modules/user/domain/user.entity';
import { UserRepository } from 'src/modules/user/domain/user.repository';
import { IncomingMessage, MessagingGateway } from '../domain/messaging.gateway.port';
import { MessageOrchestrator } from './message-orchestrator';
import { ReceiptJobHandler } from './receipt-job.handler';
import { ReceiptJobProducer } from './receipt-job.producer';
import { ReplyBuilder } from './reply-builder';

const USER_ID = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b';
const user = { id: USER_ID, telegramId: '7001', chatId: '7001' } as UserEntity;
const message: IncomingMessage = {
  messageId: '7001:55',
  from: '7001',
  chatId: '7001',
  text: '',
  attachment: { kind: 'image', fileId: 'AgACAgUAAxkBAAIB', sizeBytes: 1000 },
  timestamp: new Date(),
};

const fakeQueue = (over: Partial<JobQueue> = {}): jest.Mocked<JobQueue> =>
  ({
    enabled: true,
    enqueue: jest.fn().mockResolvedValue('enqueued'),
    registerHandler: jest.fn(),
    onFinalFailure: jest.fn(),
    scheduleEvery: jest.fn(),
    check: jest.fn(),
    ...over,
  }) as unknown as jest.Mocked<JobQueue>;

describe('ReceiptJobProducer', () => {
  it('stays out of the way when queues are off', async () => {
    const jobs = fakeQueue({ enabled: false });
    expect(await new ReceiptJobProducer(jobs).tryEnqueue(user, message)).toBeNull();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues a REFERENCE (ids and a file id), never the picture or its text', async () => {
    const jobs = fakeQueue();
    const result = await new ReceiptJobProducer(jobs, { attempts: 4, backoffMs: 1_000 }).tryEnqueue(
      user,
      message,
    );
    expect(result).toBe('queued');
    const [queue, name, data, options] = jobs.enqueue.mock.calls[0];
    expect(queue).toBe(QUEUE_NAMES.receipts);
    expect(name).toBe('read');
    expect(Object.keys(data).sort()).toEqual(
      ['chatId', 'fileId', 'messageId', 'receivedAt', 'sizeBytes', 'userId'].sort(),
    );
    expect(options).toMatchObject({ jobId: 'receipt-7001-55', attempts: 4, backoffMs: 1_000 });
  });

  it('reports a duplicate hand-over', async () => {
    const jobs = fakeQueue({ enqueue: jest.fn().mockResolvedValue('duplicate') });
    expect(await new ReceiptJobProducer(jobs).tryEnqueue(user, message)).toBe('duplicate');
  });

  it('returns null (read it in-process) when Redis is unreachable, and counts the fallback', async () => {
    const metrics = new MetricsService();
    const jobs = fakeQueue({ enqueue: jest.fn().mockRejectedValue(new QueueUnavailableError()) });
    expect(
      await new ReceiptJobProducer(jobs, undefined, metrics).tryEnqueue(user, message),
    ).toBeNull();
    expect(metrics.render()).toContain('queue_jobs_total{queue="receipts",outcome="fallback"} 1');
    metrics.close();
  });

  it('does NOT swallow an unexpected error as a fallback', async () => {
    const jobs = fakeQueue({ enqueue: jest.fn().mockRejectedValue(new TypeError('bug')) });
    await expect(new ReceiptJobProducer(jobs).tryEnqueue(user, message)).rejects.toThrow('bug');
  });
});

describe('ReceiptJobHandler', () => {
  const payload = (over: object = {}) => ({
    userId: USER_ID,
    chatId: '7001',
    messageId: '7001:55',
    fileId: 'AgACAgUAAxkBAAIB',
    receivedAt: new Date().toISOString(),
    ...over,
  });
  const build = (found: UserEntity | null = user) => {
    const users = { findById: jest.fn().mockResolvedValue(found) } as unknown as UserRepository;
    const orchestrator = {
      readReceipt: jest.fn().mockResolvedValue({ text: 'DRAFT-REPLY' }),
    } as unknown as jest.Mocked<MessageOrchestrator>;
    const gateway = {
      sendText: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<MessagingGateway>;
    const handler = new ReceiptJobHandler(
      fakeQueue(),
      users,
      orchestrator,
      gateway,
      new ReplyBuilder(),
    );
    return { handler, orchestrator, gateway };
  };

  it("reads the photo and sends the reply to the user's own chat", async () => {
    const { handler, orchestrator, gateway } = build();
    await handler.run(payload());
    expect(orchestrator.readReceipt).toHaveBeenCalledTimes(1);
    expect(gateway.sendText).toHaveBeenCalledWith('7001', 'DRAFT-REPLY');
  });

  it("refuses a job aimed at a chat that is not the user's chat", async () => {
    const { handler, orchestrator, gateway } = build();
    await expect(handler.run(payload({ chatId: '999' }))).rejects.toMatchObject({
      code: 'chat_mismatch',
    });
    expect(orchestrator.readReceipt).not.toHaveBeenCalled();
    expect(gateway.sendText).not.toHaveBeenCalled();
  });

  it('refuses a job for an unknown user, and a malformed one', async () => {
    const { handler } = build(null);
    await expect(handler.run(payload())).rejects.toMatchObject({ code: 'unknown_user' });
    await expect(handler.run({ nonsense: true })).rejects.toBeInstanceOf(RejectedJobError);
  });

  it('starts the draft lifetime at PROCESSING time, so a job recovered after a long outage is not born expired', async () => {
    const { handler, orchestrator } = build();
    const before = Date.now();
    await handler.run(payload({ receivedAt: new Date(Date.now() - 6 * 3_600_000).toISOString() }));
    const message = orchestrator.readReceipt.mock.calls[0][1];
    expect(message.timestamp.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('does not hide a database error while telling the user a job gave up', async () => {
    const users = {
      findById: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as UserRepository;
    const handler = new ReceiptJobHandler(
      fakeQueue(),
      users,
      {} as unknown as MessageOrchestrator,
      { sendText: jest.fn() } as unknown as MessagingGateway,
      new ReplyBuilder(),
    );
    await expect(handler.giveUp(payload())).rejects.toThrow('db down');
  });

  it('lets a transient failure propagate so the queue retries it', async () => {
    const { handler, orchestrator } = build();
    orchestrator.readReceipt.mockRejectedValueOnce(new Error('telegram download failed'));
    await expect(handler.run(payload())).rejects.toThrow('telegram download failed');
  });

  it('tells the user when the job gave up, and tells NO ONE when the payload is not ours', async () => {
    const { handler, gateway } = build();
    await handler.giveUp(payload());
    expect(gateway.sendText).toHaveBeenCalledWith('7001', new ReplyBuilder().receiptJobFailed());
    gateway.sendText.mockClear();
    await handler.giveUp(payload({ chatId: '999' }));
    await handler.giveUp({ junk: 1 });
    expect(gateway.sendText).not.toHaveBeenCalled();
  });
});
