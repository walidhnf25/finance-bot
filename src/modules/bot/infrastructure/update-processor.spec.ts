import { TelegramGateway } from './telegram.gateway';
import { TelegramUpdate } from './telegram.types';
import { MAX_UPDATE_ATTEMPTS, PROCESSING_FAILED_TEXT, UpdateProcessor } from './update-processor';

const update = (id = 1, text = 'beli kopi 25rb'): TelegramUpdate => ({
  update_id: id,
  message: {
    message_id: id,
    from: { id: 42, is_bot: false, first_name: 'Budi' },
    chat: { id: 42, type: 'private' },
    date: 1_784_000_000,
    text,
  },
});

describe('UpdateProcessor', () => {
  let telegram: { handleUpdate: jest.Mock; sendText: jest.Mock };
  let processor: UpdateProcessor;

  beforeEach(() => {
    telegram = {
      handleUpdate: jest.fn().mockResolvedValue(undefined),
      sendText: jest.fn().mockResolvedValue(undefined),
    };
    processor = new UpdateProcessor(telegram as unknown as TelegramGateway);
  });

  it('is done after a successful run', async () => {
    expect(await processor.process(update())).toBe('done');
    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  it('asks for a retry while attempts remain, without bothering the user', async () => {
    telegram.handleUpdate.mockRejectedValue(new Error('db down'));
    for (let i = 1; i < MAX_UPDATE_ATTEMPTS; i++) {
      expect(await processor.process(update())).toBe('retry');
    }
    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  it('gives up on the last attempt: tells the user once, then acknowledges', async () => {
    telegram.handleUpdate.mockRejectedValue(new Error('db down'));
    for (let i = 1; i < MAX_UPDATE_ATTEMPTS; i++) await processor.process(update());

    expect(await processor.process(update())).toBe('done');
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
    expect(telegram.sendText).toHaveBeenCalledWith('42', PROCESSING_FAILED_TEXT);
  });

  it('counts attempts per update, not globally', async () => {
    telegram.handleUpdate.mockRejectedValue(new Error('x'));
    await processor.process(update(1));
    await processor.process(update(1));
    expect(await processor.process(update(2))).toBe('retry'); // update 2 is only on its first failure
  });

  it('forgets the failures of an update once it succeeds', async () => {
    telegram.handleUpdate.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(undefined);
    expect(await processor.process(update(5))).toBe('retry');
    expect(await processor.process(update(5))).toBe('done');

    telegram.handleUpdate.mockRejectedValue(new Error('x'));
    expect(await processor.process(update(5))).toBe('retry'); // starts from zero again
  });

  it('never throws, even if telling the user fails too (Telegram outage)', async () => {
    telegram.handleUpdate.mockRejectedValue(new Error('x'));
    telegram.sendText.mockRejectedValue(new Error('telegram down'));
    for (let i = 1; i < MAX_UPDATE_ATTEMPTS; i++) await processor.process(update());
    await expect(processor.process(update())).resolves.toBe('done');
  });

  it('does not message anyone for an update that carries no message', async () => {
    telegram.handleUpdate.mockRejectedValue(new Error('x'));
    const odd: TelegramUpdate = { update_id: 9 };
    for (let i = 1; i < MAX_UPDATE_ATTEMPTS; i++) await processor.process(odd);
    expect(await processor.process(odd)).toBe('done');
    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  it('bounds the memory used to track failing updates', async () => {
    telegram.handleUpdate.mockRejectedValue(new Error('x'));
    for (let i = 0; i < 5_200; i++) await processor.process(update(i));
    expect(
      (processor as unknown as { failures: Map<number, number> }).failures.size,
    ).toBeLessThanOrEqual(5_000);
  });

  describe('ordering per chat', () => {
    const inChat = (chatId: number, id: number, text = 'x'): TelegramUpdate => ({
      update_id: id,
      message: {
        message_id: id,
        from: { id: chatId, is_bot: false, first_name: 'U' },
        chat: { id: chatId, type: 'private' },
        date: 1_784_000_000,
        text,
      },
    });
    /** A handleUpdate whose completion the test controls. */
    const gated = () => {
      const log: string[] = [];
      const releases = new Map<number, () => void>();
      telegram.handleUpdate.mockImplementation(
        (u: TelegramUpdate) =>
          new Promise<void>((resolve) => {
            log.push(`start:${u.update_id}`);
            releases.set(u.update_id, () => {
              log.push(`end:${u.update_id}`);
              resolve();
            });
          }),
      );
      return { log, release: (id: number) => releases.get(id)?.() };
    };
    const tick = () => new Promise((resolve) => setImmediate(resolve));

    it('does not start a second update of the same chat before the first one finished', async () => {
      const { log, release } = gated();
      const first = processor.process(inChat(7, 1));
      const second = processor.process(inChat(7, 2));
      await tick();
      expect(log).toEqual(['start:1']); // the second one waits

      release(1);
      await tick();
      expect(log).toEqual(['start:1', 'end:1', 'start:2']);
      release(2);
      expect(await Promise.all([first, second])).toEqual(['done', 'done']);
      expect(log).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
    });

    it('keeps the arrival order for many updates of one chat', async () => {
      const seen: number[] = [];
      telegram.handleUpdate.mockImplementation(async (u: TelegramUpdate) => {
        await tick(); // a different delay per update must not reorder them
        if (u.update_id % 2 === 0) await tick();
        seen.push(u.update_id);
      });
      await Promise.all([1, 2, 3, 4, 5, 6].map((id) => processor.process(inChat(7, id))));
      expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('lets different chats run at the same time', async () => {
      const { log, release } = gated();
      const a = processor.process(inChat(1, 1));
      const b = processor.process(inChat(2, 2));
      await tick();
      expect(log).toEqual(['start:1', 'start:2']);
      release(2);
      release(1);
      await Promise.all([a, b]);
    });

    it('still runs the next update of a chat after the previous one failed', async () => {
      telegram.handleUpdate
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce(undefined);
      const first = processor.process(inChat(7, 1));
      const second = processor.process(inChat(7, 2));
      expect(await first).toBe('retry');
      expect(await second).toBe('done');
    });

    it('forgets a chat once its work is finished (no growth over time)', async () => {
      for (let chat = 1; chat <= 200; chat++) await processor.process(inChat(chat, chat));
      expect((processor as unknown as { chats: Map<string, unknown> }).chats.size).toBe(0);
    });
  });
});
