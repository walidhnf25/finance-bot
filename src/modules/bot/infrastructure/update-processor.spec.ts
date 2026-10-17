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
});
