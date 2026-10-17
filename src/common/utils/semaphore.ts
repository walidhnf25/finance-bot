/**
 * A minimal counting semaphore: at most `max` holders at a time, the rest wait in arrival order.
 * Used to keep AI calls from piling up on a machine that can only run one model request
 * usefully at a time. Releasing twice is harmless.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error('Semaphore needs max >= 1');
  }

  /** Resolves with a `release` function once a slot is free. */
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next)
        next(); // hand the slot straight to the next waiter
      else this.active -= 1;
    };
  }

  get waiting(): number {
    return this.waiters.length;
  }
}
