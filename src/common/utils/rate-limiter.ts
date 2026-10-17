export interface RateDecision {
  allowed: boolean;
  /** True only for the first rejection in a window, so callers warn the user once, not per message. */
  firstRejection: boolean;
  /** When the next message would be accepted. */
  retryAfterMs: number;
}

/**
 * In-memory sliding-window limiter (per key). The finance bot runs as one process, so a distributed
 * limiter would add infrastructure without adding protection. Memory is bounded: when more than
 * `maxKeys` keys are tracked, expired ones are dropped first, then the oldest.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly warned = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  tryAcquire(key: string): RateDecision {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const last = this.warned.get(key);
      const firstRejection = last === undefined || now - last >= this.windowMs;
      if (firstRejection) this.warned.set(key, now);
      return { allowed: false, firstRejection, retryAfterMs: this.windowMs - (now - recent[0]) };
    }

    recent.push(now);
    this.hits.set(key, recent);
    this.evictIfNeeded(now);
    return { allowed: true, firstRejection: false, retryAfterMs: 0 };
  }

  private evictIfNeeded(now: number): void {
    if (this.hits.size <= this.maxKeys) return;
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) {
        this.hits.delete(key);
        this.warned.delete(key);
      }
    }
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value as string;
      this.hits.delete(oldest);
      this.warned.delete(oldest);
    }
  }
}
