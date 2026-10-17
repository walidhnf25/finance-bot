import { ConfigService } from '@nestjs/config';
import { UpdateProcessor } from './update-processor';
import { TelegramGateway } from './telegram.gateway';
import { TelegramPoller } from './telegram.poller';
import { TelegramUpdate } from './telegram.types';

const upd = (id: number): TelegramUpdate => ({ update_id: id });

/** An empty long poll: resolves on a later tick, like the real server-side wait. */
const idle = (): Promise<TelegramUpdate[]> =>
  new Promise((resolve) => setImmediate(() => resolve([])));

/** Lets the poll loop run until `until()` is true (or the safety limit is hit). */
async function waitFor(until: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!until() && Date.now() < end) await new Promise((r) => setImmediate(r));
}

function build(polling: boolean, getUpdates: jest.Mock, process: jest.Mock): TelegramPoller {
  const config = {
    get: (key: string, fallback?: unknown) => (key === 'telegram.polling' ? polling : fallback),
  } as ConfigService;
  return new TelegramPoller(
    { getUpdates } as unknown as TelegramGateway,
    { process } as unknown as UpdateProcessor,
    config,
  );
}

describe('TelegramPoller (offset handling = no lost updates)', () => {
  beforeEach(() => {
    // Make backoff sleeps instant but keep promises/immediates working.
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('does nothing when polling is disabled (webhook mode)', async () => {
    const getUpdates = jest.fn();
    const poller = build(false, getUpdates, jest.fn());
    poller.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    expect(getUpdates).not.toHaveBeenCalled();
  });

  it('moves the offset past an update only after it was processed', async () => {
    const calls: number[] = [];
    let processed = 0;
    const getUpdates = jest.fn().mockImplementation((offset: number) => {
      calls.push(offset);
      return calls.length === 1 ? Promise.resolve([upd(10), upd(11)]) : idle();
    });
    const process = jest.fn().mockImplementation(() => {
      processed++;
      return Promise.resolve('done');
    });
    const poller = build(true, getUpdates, process);
    poller.onApplicationBootstrap();
    await waitFor(() => calls.length >= 2);
    await poller.onModuleDestroy();

    expect(processed).toBe(2);
    expect(calls.slice(0, 2)).toEqual([0, 12]); // after 10 and 11 were done
  });

  it('re-runs the SAME update until it is done, and never skips ahead meanwhile', async () => {
    const seen: number[] = [];
    let attempts = 0;
    const getUpdates = jest.fn().mockImplementation((offset: number) => {
      seen.push(offset);
      return seen.length === 1 ? Promise.resolve([upd(5), upd(6)]) : idle();
    });
    const order: number[] = [];
    const process = jest.fn().mockImplementation((u: TelegramUpdate) => {
      order.push(u.update_id);
      if (u.update_id === 5 && ++attempts < 3) return Promise.resolve('retry');
      return Promise.resolve('done');
    });
    const poller = build(true, getUpdates, process);
    poller.onApplicationBootstrap();
    await waitFor(() => seen.length >= 2);
    await poller.onModuleDestroy();

    expect(order).toEqual([5, 5, 5, 6]); // update 6 waits for 5; no update is dropped
    expect(seen[1]).toBe(7);
  });

  it('survives getUpdates failures (e.g. network down) and keeps the offset', async () => {
    let n = 0;
    const getUpdates = jest.fn().mockImplementation(() => {
      n++;
      if (n === 1) return Promise.resolve([upd(20)]);
      if (n === 2) return Promise.reject(new Error('network down'));
      return idle();
    });
    const poller = build(true, getUpdates, jest.fn().mockResolvedValue('done'));
    poller.onApplicationBootstrap();
    await waitFor(() => getUpdates.mock.calls.length >= 3);
    await poller.onModuleDestroy();

    expect(getUpdates.mock.calls.map((c: unknown[]) => c[0] as number).slice(0, 3)).toEqual([
      0, 21, 21,
    ]);
  });

  it('stops promptly on shutdown, without advancing past an unfinished update', async () => {
    // An empty poll that yields to the event loop (like the real server-side wait). A fake that resolved
    // instantly in a microtask loop would starve the test and run out of memory if the loop misbehaved.
    const getUpdates = jest
      .fn()
      .mockResolvedValueOnce([upd(30)])
      .mockImplementation(() => idle());
    let release: (v: 'retry') => void = () => undefined;
    const process = jest
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => (release = resolve as (v: 'retry') => void)),
      );
    const poller = build(true, getUpdates, process);
    poller.onApplicationBootstrap();
    await waitFor(() => process.mock.calls.length >= 1);
    expect(process).toHaveBeenCalledTimes(1); // the update was handed to the processor

    const shutdown = poller.onModuleDestroy();
    release('retry'); // the update asks to be retried while the app is stopping
    await shutdown;
    const callsAtStop = getUpdates.mock.calls.length;
    await new Promise((r) => setImmediate(r));
    expect(getUpdates.mock.calls.length).toBe(callsAtStop); // no further polling after stop
  });
});
