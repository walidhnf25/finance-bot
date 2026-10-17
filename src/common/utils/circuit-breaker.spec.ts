import { CircuitBreaker, BreakerState } from './circuit-breaker';

function make(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  let t = 1_000;
  const transitions: Array<[BreakerState, BreakerState]> = [];
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 10_000,
    now: () => t,
    onTransition: (from, to) => transitions.push([from, to]),
    ...overrides,
  });
  return {
    breaker,
    transitions,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('CircuitBreaker', () => {
  it('starts CLOSED and lets calls through', () => {
    const { breaker } = make();
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.allow()).toBe(true);
    expect(breaker.blocked()).toBe(false);
  });

  it('opens only after the threshold of CONSECUTIVE failures', () => {
    const { breaker } = make();
    breaker.failure();
    breaker.failure();
    expect(breaker.state).toBe('CLOSED');
    breaker.success(); // a success resets the streak
    breaker.failure();
    breaker.failure();
    expect(breaker.state).toBe('CLOSED');
    breaker.failure();
    expect(breaker.state).toBe('OPEN');
  });

  it('refuses calls while OPEN and during the cooldown, without waiting', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i += 1) breaker.failure();
    expect(breaker.allow()).toBe(false);
    expect(breaker.blocked()).toBe(true);
    advance(9_999);
    expect(breaker.allow()).toBe(false);
  });

  it('after the cooldown lets exactly ONE probe through and refuses the rest', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i += 1) breaker.failure();
    advance(10_000);
    expect(breaker.blocked()).toBe(false); // a probe slot is available
    expect(breaker.allow()).toBe(true); // the probe
    expect(breaker.state).toBe('HALF_OPEN');
    expect(breaker.allow()).toBe(false); // everyone else keeps being refused
    expect(breaker.allow()).toBe(false);
    expect(breaker.blocked()).toBe(true);
  });

  it('a successful probe closes the breaker and resets the failure count', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i += 1) breaker.failure();
    advance(10_000);
    breaker.allow();
    breaker.success();
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.allow()).toBe(true);
    breaker.failure();
    breaker.failure();
    expect(breaker.state).toBe('CLOSED'); // the old streak did not carry over
  });

  it('a failed probe re-opens the breaker for a full new cooldown', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i += 1) breaker.failure();
    advance(10_000);
    breaker.allow();
    breaker.failure();
    expect(breaker.state).toBe('OPEN');
    advance(9_999);
    expect(breaker.allow()).toBe(false);
    advance(1);
    expect(breaker.allow()).toBe(true);
  });

  it('cancelProbe frees the slot without judging the dependency', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i += 1) breaker.failure();
    advance(10_000);
    expect(breaker.allow()).toBe(true);
    breaker.cancelProbe();
    expect(breaker.state).toBe('HALF_OPEN');
    expect(breaker.allow()).toBe(true); // another probe may go
  });

  it('reports every transition once, in order', () => {
    const { breaker, advance, transitions } = make();
    for (let i = 0; i < 3; i += 1) breaker.failure();
    advance(10_000);
    breaker.allow();
    breaker.success();
    expect(transitions).toEqual([
      ['CLOSED', 'OPEN'],
      ['OPEN', 'HALF_OPEN'],
      ['HALF_OPEN', 'CLOSED'],
    ]);
  });

  it('a throwing metrics hook never breaks the breaker', () => {
    const { breaker } = make({
      onTransition: () => {
        throw new Error('hook failed');
      },
    });
    for (let i = 0; i < 3; i += 1) breaker.failure();
    expect(breaker.state).toBe('OPEN');
  });

  it('rejects nonsense configuration', () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0, cooldownMs: 1 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ failureThreshold: 1.5, cooldownMs: 1 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ failureThreshold: 1, cooldownMs: -1 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ failureThreshold: 1, cooldownMs: NaN })).toThrow(RangeError);
  });

  it('under concurrent callers only one is ever admitted as the probe', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i += 1) breaker.failure();
    advance(10_000);
    const admitted = Array.from({ length: 50 }, () => breaker.allow()).filter(Boolean);
    expect(admitted).toHaveLength(1);
  });
});
