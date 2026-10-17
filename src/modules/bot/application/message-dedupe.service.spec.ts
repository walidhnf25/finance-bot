import { MessageDedupeService } from './message-dedupe.service';

describe('MessageDedupeService', () => {
  it('only remembers a message once it was marked done', () => {
    const dedupe = new MessageDedupeService();
    expect(dedupe.has('a')).toBe(false); // seeing it does NOT record it: a failed message must be retried
    expect(dedupe.has('a')).toBe(false);

    dedupe.markDone('a');
    expect(dedupe.has('a')).toBe(true);
    expect(dedupe.has('b')).toBe(false);
  });

  it('ignores empty ids', () => {
    const dedupe = new MessageDedupeService();
    dedupe.markDone('');
    expect(dedupe.has('')).toBe(false);
  });

  it('is bounded: the oldest entries are evicted', () => {
    const dedupe = new MessageDedupeService();
    for (let i = 0; i < 2100; i++) dedupe.markDone(`m${i}`);
    expect(dedupe.has('m0')).toBe(false); // evicted
    expect(dedupe.has('m2099')).toBe(true);
  });

  it('marking twice is harmless', () => {
    const dedupe = new MessageDedupeService();
    dedupe.markDone('x');
    dedupe.markDone('x');
    expect(dedupe.has('x')).toBe(true);
  });
});
