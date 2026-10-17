import { Injectable } from '@nestjs/common';

/**
 * Bounded in-memory cache of messages that were fully handled. It is only a cheap first line of
 * defence against redelivered updates; correctness does not depend on it: every financial write
 * has a database-enforced idempotency key, which survives restarts and concurrent instances.
 *
 * A message is added with {@link markDone} only after it succeeded, so a failed one is retried.
 */
@Injectable()
export class MessageDedupeService {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly maxEntries = 2000;

  has(messageId: string): boolean {
    return messageId !== '' && this.seen.has(messageId);
  }

  markDone(messageId: string): void {
    if (!messageId || this.seen.has(messageId)) return;
    this.seen.add(messageId);
    this.order.push(messageId);
    if (this.order.length > this.maxEntries) {
      const evicted = this.order.shift();
      if (evicted) this.seen.delete(evicted);
    }
  }
}
