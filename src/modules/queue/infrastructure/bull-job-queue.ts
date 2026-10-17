import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Job, JobsOptions, Queue, UnrecoverableError, Worker } from 'bullmq';
import { MetricsService } from 'src/modules/observability/metrics.service';
import {
  EnqueueOptions,
  EnqueueResult,
  FinalFailureHandler,
  JobHandler,
  JobHandlerOptions,
  JobQueue,
  QueueName,
  QueueUnavailableError,
  RejectedJobError,
} from '../domain/job-queue';

const DEFAULT_TIMEOUT_MS = 120_000;
/** A producer call that has not answered by now means Redis is unreachable: fail fast, never hang a chat. */
const PRODUCER_TIMEOUT_MS = 3_000;
const GAUGE_REFRESH_MS = 15_000;
const SHUTDOWN_GRACE_MS = 20_000;

/** Waits for `work` but never longer than `ms`; a failure or a hang must not block shutdown. */
const within = (work: Promise<unknown>, ms: number): Promise<unknown> => {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([work.catch(() => undefined), limit]).finally(
    () => timer && clearTimeout(timer),
  );
};

interface QueueSettings {
  redisUrl: string;
  connectTimeoutMs: number;
  keyPrefix: string;
  /** How long shutdown waits for a running job before forcing the worker closed (tests shorten it). */
  shutdownGraceMs?: number;
}

interface Registered {
  handler: JobHandler;
  timeoutMs: number;
  concurrency: number;
}

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueueUnavailableError('queue backend did not answer')), ms);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => timer && clearTimeout(timer));
};

/** Never put anything user-derived (payload, file ids, text) in a log line. */
const reasonOf = (err: unknown): string => {
  if (err instanceof RejectedJobError) return err.code;
  // a network error code ("ECONNREFUSED") is a fixed word and safe to log; a message could carry anything
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z_]{3,30}$/.test(code)) return code;
  if (err instanceof Error) return err.name;
  return 'error';
};

/**
 * BullMQ on Redis, behind the JobQueue port. Active only when REDIS_URL is set.
 *
 *  - One worker per queue; handlers are registered per job name and dispatched by name.
 *  - Workers start only after the application bootstrapped, so no job can reach a handler that is not
 *    registered yet.
 *  - Producers fail fast (no offline queue, 3 s guard): a down Redis becomes QueueUnavailableError and the
 *    caller falls back to doing the work in-process. Workers reconnect on their own.
 *  - Every queue keeps bounded history; failed jobs stay (bounded) as the dead-letter view.
 *  - Graceful shutdown: workers finish the job they hold, then connections close.
 */
@Injectable()
export class BullJobQueue extends JobQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BullJobQueue.name);
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();
  private readonly handlers = new Map<string, Map<string, Registered>>();
  private readonly finalFailure = new Map<string, FinalFailureHandler>();
  private readonly settings: QueueSettings;
  private readonly prefix: string;
  private started = false;
  private closing = false;
  private readonly lastWarn = new Map<string, number>();
  private gaugeTimer?: NodeJS.Timeout;
  private gauge = { waiting: 0, active: 0, failed: 0 };

  constructor(
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
    this.settings = config.getOrThrow<QueueSettings>('queue');
    this.prefix = `${this.settings.keyPrefix}bull`;
    metrics?.registerGauge('queue_waiting', () => this.gauge.waiting);
    metrics?.registerGauge('queue_active', () => this.gauge.active);
    metrics?.registerGauge('queue_failed', () => this.gauge.failed);
  }

  get enabled(): boolean {
    return this.settings.redisUrl !== '';
  }

  /* ---------------------------------------------------------------- producer side */

  async enqueue(
    queue: QueueName,
    name: string,
    data: object,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    if (!this.enabled) throw new QueueUnavailableError('queues are disabled (REDIS_URL empty)');
    const q = this.queue(queue);
    const correlationId = options.correlationId ?? randomUUID();
    const jobOptions: JobsOptions = {
      jobId: options.jobId,
      attempts: options.attempts ?? 1,
      backoff: options.backoffMs ? { type: 'exponential', delay: options.backoffMs } : undefined,
    };
    try {
      if (options.jobId && (await withTimeout(q.getJob(options.jobId), PRODUCER_TIMEOUT_MS))) {
        this.metrics?.inc('queue_jobs_total', { queue, outcome: 'duplicate' });
        return 'duplicate';
      }
      await withTimeout(q.add(name, { ...data, correlationId }, jobOptions), PRODUCER_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof QueueUnavailableError) throw err;
      throw new QueueUnavailableError(reasonOf(err));
    }
    this.metrics?.inc('queue_jobs_total', { queue, outcome: 'enqueued' });
    return 'enqueued';
  }

  async scheduleEvery(queue: QueueName, name: string, everyMs: number): Promise<void> {
    if (!this.enabled) return;
    const q = this.queue(queue);
    try {
      // a schedule left over from another interval (the setting changed) must go
      for (const s of await withTimeout(q.getJobSchedulers(), PRODUCER_TIMEOUT_MS)) {
        if (s.name === name && s.every !== everyMs && s.key) {
          await q.removeJobScheduler(s.key);
        }
      }
      await withTimeout(
        q.upsertJobScheduler(`${name}-every`, { every: everyMs }, { name, data: {} }),
        PRODUCER_TIMEOUT_MS,
      );
    } catch (err) {
      throw err instanceof QueueUnavailableError ? err : new QueueUnavailableError(reasonOf(err));
    }
  }

  async check(): Promise<{ status: 'disabled' | 'up' | 'down'; detail?: string }> {
    if (!this.enabled) return { status: 'disabled' };
    try {
      // any cheap command proves the round trip; producers have no offline queue, so a dead Redis fails at once
      await withTimeout(this.queue('receipts').getJobCounts('waiting'), PRODUCER_TIMEOUT_MS);
      return { status: 'up' };
    } catch {
      return { status: 'down', detail: 'Redis is not reachable' };
    }
  }

  /* ---------------------------------------------------------------- consumer side */

  registerHandler(
    queue: QueueName,
    name: string,
    handler: JobHandler,
    options: JobHandlerOptions = {},
  ): void {
    if (!this.enabled) return; // queues off: the in-process path is the only path
    let byName = this.handlers.get(queue);
    if (!byName) {
      byName = new Map();
      this.handlers.set(queue, byName);
    }
    byName.set(name, {
      handler,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      concurrency: options.concurrency ?? 1,
    });
    if (this.started) this.ensureWorker(queue);
  }

  onFinalFailure(queue: QueueName, name: string, handler: FinalFailureHandler): void {
    this.finalFailure.set(`${queue}:${name}`, handler);
  }

  onApplicationBootstrap(): void {
    this.started = true;
    for (const queue of this.handlers.keys()) this.ensureWorker(queue as QueueName);
  }

  /** Graceful shutdown: workers finish the job they hold, then connections close. */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    const grace = this.settings.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    // A worker finishes the job it holds; if that takes too long, or Redis is gone and close() would wait
    // for a connection that never comes, it is forced closed so the process can still exit.
    await Promise.allSettled(
      [...this.workers.values()].map(async (w) => {
        await within(w.close(), grace);
        await within(w.close(true), 2_000);
        await within(w.disconnect(), 1_000);
      }),
    );
    await Promise.allSettled(
      [...this.queues.values()].map(async (q) => {
        await within(q.close(), 3_000);
        await within(q.disconnect(), 1_000);
      }),
    );
  }

  /** Waiting/active/failed counts of one queue (diagnosis and metrics). */
  async counts(queue: QueueName): Promise<{ waiting: number; active: number; failed: number }> {
    const c = await this.queue(queue).getJobCounts('waiting', 'active', 'failed', 'delayed');
    return {
      waiting: (c.waiting ?? 0) + (c.delayed ?? 0),
      active: c.active ?? 0,
      failed: c.failed ?? 0,
    };
  }

  /* ---------------------------------------------------------------- internals */

  private connection(forWorker: boolean): Record<string, unknown> {
    const u = new URL(this.settings.redisUrl);
    const db = Number(u.pathname.replace('/', '') || '0');
    return {
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port || '6379'),
      db: Number.isFinite(db) ? db : 0,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      tls: u.protocol === 'rediss:' ? {} : undefined,
      connectTimeout: this.settings.connectTimeoutMs,
      // BullMQ workers need `null`; producers must not queue commands while Redis is down.
      maxRetriesPerRequest: forWorker ? null : 1,
      enableOfflineQueue: forWorker,
      // Reconnect with a growing pause, and STOP once shutdown began: otherwise a connection to a dead Redis
      // keeps a retry timer alive and the process cannot exit.
      retryStrategy: (times: number) => (this.closing ? null : Math.min(times * 200, 3_000)),
    };
  }

  private queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection(false),
        prefix: this.prefix,
        defaultJobOptions: {
          removeOnComplete: { count: 200, age: 24 * 3600 },
          removeOnFail: { count: 1000, age: 7 * 24 * 3600 }, // the dead-letter view, bounded
          attempts: 1,
        },
      });
      q.on('error', (e: Error) => this.warnOnce(`queue ${name}`, e));
      this.queues.set(name, q);
    }
    return q;
  }

  private ensureWorker(queue: QueueName): void {
    if (this.workers.has(queue)) return;
    const registered = [...(this.handlers.get(queue)?.values() ?? [])];
    const longest = Math.max(DEFAULT_TIMEOUT_MS, ...registered.map((r) => r.timeoutMs));
    const worker = new Worker(queue, (job) => this.dispatch(queue, job), {
      connection: this.connection(true),
      prefix: this.prefix,
      concurrency: Math.max(1, ...registered.map((r) => r.concurrency)),
      // the lock must outlive the longest handler, or a healthy job would look stalled
      lockDuration: longest + 30_000,
    });
    worker.on('error', (e: Error) => this.warnOnce(`worker ${queue}`, e));
    worker.on('failed', (job, err) => void this.afterFailure(queue, job, err));
    this.workers.set(queue, worker);
    this.startGauges();
  }

  private async dispatch(queue: QueueName, job: Job): Promise<void> {
    const registered = this.handlers.get(queue)?.get(job.name);
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!registered) throw new RejectedJobError('unknown_job');
      const data = job.data as { correlationId?: string };
      await Promise.race([
        registered.handler(job.data, {
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1,
          correlationId: data?.correlationId,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`job timed out after ${registered.timeoutMs} ms`)),
            registered.timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      this.metrics?.inc('queue_jobs_total', { queue, outcome: 'completed' });
    } catch (err) {
      if (err instanceof RejectedJobError) {
        this.metrics?.inc('queue_jobs_total', { queue, outcome: 'rejected' });
        // Whatever was written to Redis may be hostile or huge: do not keep it in the failed set.
        await job.updateData({ rejected: err.code }).catch(() => undefined);
        // BullMQ never retries an UnrecoverableError, whatever the configured attempts.
        throw new UnrecoverableError(err.message);
      }
      const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      this.metrics?.inc('queue_jobs_total', { queue, outcome: last ? 'failed' : 'retried' });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.metrics?.observe('queue_job_ms', Date.now() - started, { queue });
    }
  }

  /** Runs after every failed attempt; acts only when the job is now failed for good. */
  private async afterFailure(queue: QueueName, job: Job | undefined, err: Error): Promise<void> {
    if (!job || this.closing) return;
    try {
      if (!(await job.isFailed())) return; // a retry is scheduled
      const data = job.data as { correlationId?: string };
      this.logger.error(
        JSON.stringify({
          evt: 'JOB_FAILED',
          queue,
          job: job.name,
          correlationId: data?.correlationId,
          attempts: job.attemptsMade,
          reason: reasonOf(err),
        }),
      );
      const notify = this.finalFailure.get(`${queue}:${job.name}`);
      if (notify) await notify(job.data, reasonOf(err));
    } catch (e) {
      this.logger.warn(`final-failure handling of ${queue}/${job.name}: ${reasonOf(e)}`);
    }
  }

  /** A dead Redis raises an error on every reconnect attempt: say so once a minute, not once a second. */
  private warnOnce(source: string, err: Error): void {
    if (this.closing) return;
    const now = Date.now();
    if (now - (this.lastWarn.get(source) ?? 0) < 60_000) return;
    this.lastWarn.set(source, now);
    this.logger.warn(`${source}: ${reasonOf(err)} (repeats are not logged for a minute)`);
  }

  private startGauges(): void {
    if (this.gaugeTimer) return;
    const refresh = async (): Promise<void> => {
      try {
        const totals = { waiting: 0, active: 0, failed: 0 };
        for (const name of this.queues.keys()) {
          const c = await this.counts(name as QueueName);
          totals.waiting += c.waiting;
          totals.active += c.active;
          totals.failed += c.failed;
        }
        this.gauge = totals;
      } catch {
        /* Redis down: the gauges keep their last value */
      }
    };
    this.gaugeTimer = setInterval(() => void refresh(), GAUGE_REFRESH_MS);
    this.gaugeTimer.unref?.();
  }
}
