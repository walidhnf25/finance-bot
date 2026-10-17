import { Semaphore } from './semaphore';

describe('Semaphore', () => {
  it('lets only `max` holders in at once and serves the rest in arrival order', async () => {
    const gate = new Semaphore(2);
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const job = async (name: string, ms: number) => {
      const release = await gate.acquire();
      active += 1;
      peak = Math.max(peak, active);
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      active -= 1;
      order.push(`end ${name}`);
      release();
    };
    await Promise.all([job('a', 30), job('b', 30), job('c', 10), job('d', 10)]);
    expect(peak).toBe(2);
    expect(order.filter((o) => o.startsWith('start'))).toEqual([
      'start a',
      'start b',
      'start c',
      'start d',
    ]);
  });

  it('frees the slot when the holder releases, even after an error', async () => {
    const gate = new Semaphore(1);
    const failing = (async () => {
      const release = await gate.acquire();
      try {
        throw new Error('boom');
      } finally {
        release();
      }
    })();
    await expect(failing).rejects.toThrow('boom');
    const release = await Promise.race([
      gate.acquire(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('stuck')), 500)),
    ]);
    release();
  });

  it('ignores a second release of the same slot', async () => {
    const gate = new Semaphore(1);
    const release = await gate.acquire();
    release();
    release(); // must not create a phantom slot
    const first = await gate.acquire();
    let secondGranted = false;
    void gate.acquire().then(() => {
      secondGranted = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(secondGranted).toBe(false);
    first();
  });

  it('rejects a nonsensical size', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });
});
