/**
 * Circuit breaker for one unreliable dependency (here: the Ollama server).
 *
 *   CLOSED    calls pass; `failureThreshold` CONSECUTIVE failures open the breaker.
 *   OPEN      calls are refused at once (no waiting for a timeout) until `cooldownMs` has passed.
 *   HALF_OPEN after the cooldown exactly ONE probe call is let through; its success closes the
 *             breaker, its failure re-opens it. Every other caller is still refused meanwhile.
 *
 * Why it exists: without it, every receipt photo would wait out the full AI timeout (up to two
 * minutes) while Ollama is down. With it, the first few failures are paid once and the rest fall
 * straight back to the deterministic reader.
 *
 * It protects availability only. It never retries, never queues, and never touches money logic.
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  /** Injectable for tests. */
  now?: () => number;
  /** Called on every state change (for metrics); must not throw. */
  onTransition?: (from: BreakerState, to: BreakerState) => void;
}

export class CircuitBreaker {
  private current: BreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new RangeError('failureThreshold must be a positive integer');
    }
    if (!Number.isFinite(options.cooldownMs) || options.cooldownMs < 0) {
      throw new RangeError('cooldownMs must be a non-negative number');
    }
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    return this.current;
  }

  /** Non-mutating look: would a call be refused right now? (A pending probe slot counts as free.) */
  blocked(): boolean {
    if (this.current === 'CLOSED') return false;
    if (this.current === 'OPEN') return this.now() - this.openedAt < this.options.cooldownMs;
    return this.probeInFlight;
  }

  /**
   * Ask permission for ONE call. Returns false when the call must be refused. A true answer in
   * HALF_OPEN reserves the single probe slot: the caller MUST then report `success()`, `failure()`
   * or `cancelProbe()`.
   */
  allow(): boolean {
    if (this.current === 'CLOSED') return true;
    if (this.current === 'OPEN') {
      if (this.now() - this.openedAt < this.options.cooldownMs) return false;
      this.transition('HALF_OPEN');
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  success(): void {
    this.probeInFlight = false;
    this.consecutiveFailures = 0;
    if (this.current !== 'CLOSED') this.transition('CLOSED');
  }

  failure(): void {
    this.probeInFlight = false;
    if (this.current === 'HALF_OPEN') {
      this.open();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.current === 'CLOSED' && this.consecutiveFailures >= this.options.failureThreshold) {
      this.open();
    }
  }

  /** The probe was abandoned before it learned anything: free the slot without judging the dependency. */
  cancelProbe(): void {
    this.probeInFlight = false;
  }

  private open(): void {
    this.openedAt = this.now();
    this.transition('OPEN');
  }

  private transition(to: BreakerState): void {
    const from = this.current;
    if (from === to) return;
    this.current = to;
    try {
      this.options.onTransition?.(from, to);
    } catch {
      // A metrics hook must never break the guarded call.
    }
  }
}
