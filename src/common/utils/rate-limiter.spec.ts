import { SlidingWindowLimiter } from './rate-limiter';

describe('SlidingWindowLimiter', () => {
  let now: number;
  const clock = () => now;
  beforeEach(() => {
    now = 1_000_000;
  });

  it('allows up to the limit, then rejects', () => {
    const limiter = new SlidingWindowLimiter(3, 60_000, clock);
    expect([1, 2, 3].map(() => limiter.tryAcquire('u').allowed)).toEqual([true, true, true]);
    expect(limiter.tryAcquire('u').allowed).toBe(false);
  });

  it('keeps users separate', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, clock);
    expect(limiter.tryAcquire('a').allowed).toBe(true);
    expect(limiter.tryAcquire('a').allowed).toBe(false);
    expect(limiter.tryAcquire('b').allowed).toBe(true);
  });

  it('slides: old hits stop counting once the window passes', () => {
    const limiter = new SlidingWindowLimiter(2, 10_000, clock);
    limiter.tryAcquire('u'); // t=0
    now += 6_000;
    limiter.tryAcquire('u'); // t=6s
    expect(limiter.tryAcquire('u').allowed).toBe(false);

    now += 5_000; // t=11s: the first hit (t=0) has expired, the second (t=6s) has not
    expect(limiter.tryAcquire('u').allowed).toBe(true);
    expect(limiter.tryAcquire('u').allowed).toBe(false);
  });

  it('reports when the next message would be accepted', () => {
    const limiter = new SlidingWindowLimiter(1, 10_000, clock);
    limiter.tryAcquire('u');
    now += 4_000;
    expect(limiter.tryAcquire('u').retryAfterMs).toBe(6_000);
  });

  it('flags only the first rejection of a window, so the user is warned once', () => {
    const limiter = new SlidingWindowLimiter(1, 10_000, clock);
    limiter.tryAcquire('u');
    expect(limiter.tryAcquire('u').firstRejection).toBe(true);
    expect(limiter.tryAcquire('u').firstRejection).toBe(false);
    expect(limiter.tryAcquire('u').firstRejection).toBe(false);

    now += 10_001; // a new window: allowed again, then rejected again, and warned again once
    expect(limiter.tryAcquire('u').allowed).toBe(true);
    expect(limiter.tryAcquire('u').firstRejection).toBe(true);
  });

  it('does not count rejected attempts against the user', () => {
    const limiter = new SlidingWindowLimiter(2, 10_000, clock);
    limiter.tryAcquire('u');
    limiter.tryAcquire('u');
    for (let i = 0; i < 50; i++) limiter.tryAcquire('u'); // hammering while limited
    now += 10_001;
    expect(limiter.tryAcquire('u').allowed).toBe(true); // recovers as soon as the window passes
  });

  it('keeps memory bounded when many different users appear', () => {
    const limiter = new SlidingWindowLimiter(5, 10_000, clock, 100);
    for (let i = 0; i < 1_000; i++) limiter.tryAcquire(`user-${i}`);
    expect((limiter as unknown as { hits: Map<string, number[]> }).hits.size).toBeLessThanOrEqual(
      100,
    );
  });
});
