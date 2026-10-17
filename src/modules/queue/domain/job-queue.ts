/**
 * Background jobs, as the application sees them. The queue is OPTIONAL: without
 * Redis `enabled` is false and every caller keeps its in-process path, so nothing about the bot changes
 * unless the owner turns it on with REDIS_URL.
 *
 * Jobs are delivered AT LEAST ONCE. A handler must therefore be safe to run twice for the same job (the
 * receipt handler is: drafts are keyed by the image hash, confirmation is atomic and idempotent).
 */
export const QUEUE_NAMES = {
  /** Receipt photos: download, OCR, optional model, draft, reply. */
  receipts: 'receipts',
  /** Housekeeping (retention). */
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface EnqueueOptions {
  /** Same id = same job: a second enqueue while the first is waiting, running or recently finished is ignored. */
  jobId?: string;
  /** Total tries (the first run counts). */
  attempts?: number;
  /** First retry delay; doubles on every further retry. */
  backoffMs?: number;
  correlationId?: string;
}

export type EnqueueResult = 'enqueued' | 'duplicate';

export interface JobContext {
  /** 1 for the first run. */
  attempt: number;
  maxAttempts: number;
  correlationId?: string;
}

export interface JobHandlerOptions {
  /** A job running longer than this is failed and its lock released. */
  timeoutMs?: number;
  /** Jobs of this queue run at the same time. Keep it low for OCR. */
  concurrency?: number;
}

export type JobHandler = (data: unknown, context: JobContext) => Promise<void>;
/** Called once when a job has failed for good (retries exhausted, rejected, or stalled too often). */
export type FinalFailureHandler = (data: unknown, reason: string) => Promise<void>;

/** Redis could not be reached in time: the caller falls back to its in-process path. */
export class QueueUnavailableError extends Error {
  constructor(detail = 'queue backend unreachable') {
    super(detail);
    this.name = 'QueueUnavailableError';
  }
}

/**
 * A job whose payload is not acceptable (anything written to Redis is untrusted input). It is failed once
 * and never retried; only the short reason code is logged, never the payload.
 */
export class RejectedJobError extends Error {
  constructor(readonly code: string) {
    super(`job rejected: ${code}`);
    this.name = 'RejectedJobError';
  }
}

export abstract class JobQueue {
  abstract readonly enabled: boolean;
  abstract enqueue(
    queue: QueueName,
    name: string,
    data: object,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult>;
  abstract registerHandler(
    queue: QueueName,
    name: string,
    handler: JobHandler,
    options?: JobHandlerOptions,
  ): void;
  abstract onFinalFailure(queue: QueueName, name: string, handler: FinalFailureHandler): void;
  /** One repeating job per name, whichever process asks (idempotent). */
  abstract scheduleEvery(queue: QueueName, name: string, everyMs: number): Promise<void>;
  /** Reachability of the backend for health checks (never throws). */
  abstract check(): Promise<{ status: 'disabled' | 'up' | 'down'; detail?: string }>;
}
