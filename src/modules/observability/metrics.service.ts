import { Injectable } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * A tiny in-process metrics registry in the Prometheus text format. No dependency, no network, no
 * dashboard: `GET /metrics` on the loopback API is enough for a single bot.
 *
 * Safety rules, enforced here rather than left to callers:
 *  - Only metrics declared in {@link CATALOGUE} exist. An undeclared name is ignored.
 *  - Label values must be in the metric's declared set; anything else is recorded as "other". A user id,
 *    chat id, amount, merchant or message text can therefore never become a label (no PII, and the
 *    number of series stays bounded).
 *  - Recording never throws: a metric must not be able to break a financial operation.
 */

type MetricType = 'counter' | 'histogram' | 'gauge';

interface Definition {
  type: MetricType;
  help: string;
  /** label name -> allowed values */
  labels?: Record<string, readonly string[]>;
}

const UPDATE_OUTCOMES = ['processed', 'duplicate', 'rate_limited', 'too_long', 'failed'] as const;
const RECEIPT_OUTCOMES = [
  'draft',
  'pending_exists',
  'already_confirmed',
  'rate_limited',
  'rejected_image',
  'unreadable',
  'busy',
  'error',
] as const;

export const CATALOGUE = {
  updates_total: {
    type: 'counter',
    help: 'Telegram messages handled, by outcome.',
    labels: { outcome: UPDATE_OUTCOMES },
  },
  updates_unauthorized_total: {
    type: 'counter',
    help: 'Messages from senders that are not authorized (ignored).',
  },
  update_attempts_total: {
    type: 'counter',
    help: 'Update processing attempts, by result (retry = will be run again).',
    labels: { result: ['done', 'retry', 'given_up'] },
  },
  message_latency_ms: { type: 'histogram', help: 'Time to handle one message, in ms.' },
  receipts_total: {
    type: 'counter',
    help: 'Receipt photos submitted, by outcome.',
    labels: { outcome: RECEIPT_OUTCOMES },
  },
  receipt_duration_ms: { type: 'histogram', help: 'Time to turn a photo into a draft, in ms.' },
  ocr_failures_total: {
    type: 'counter',
    help: 'OCR failures, by reason.',
    labels: { reason: ['language_data_missing', 'engine_error', 'timeout', 'busy'] },
  },
  ai_requests_total: {
    type: 'counter',
    help: 'AI operations, by outcome.',
    labels: { outcome: ['ok', 'unavailable'] },
  },
  ai_breaker_transitions_total: {
    type: 'counter',
    help: 'AI circuit breaker state changes, by new state.',
    labels: { to: ['CLOSED', 'OPEN', 'HALF_OPEN'] },
  },
  retention_deleted_total: {
    type: 'counter',
    help: 'Rows removed by the retention job, by kind.',
    labels: { kind: ['receipt_drafts', 'conversations', 'audit_events'] },
  },
  retention_expired_total: {
    type: 'counter',
    help: 'Pending receipt drafts marked expired by the retention job.',
  },
  telegram_errors_total: {
    type: 'counter',
    help: 'Errors talking to Telegram, by kind.',
    labels: { kind: ['poll', 'send', 'download'] },
  },
  queue_jobs_total: {
    type: 'counter',
    help: 'Background queue jobs, by queue and outcome (fallback = Redis unreachable, done in-process).',
    labels: {
      queue: ['receipts', 'maintenance'],
      outcome: ['enqueued', 'duplicate', 'completed', 'retried', 'failed', 'rejected', 'fallback'],
    },
  },
  queue_job_ms: {
    type: 'histogram',
    help: 'Time a background job ran, in ms.',
    labels: { queue: ['receipts', 'maintenance'] },
  },
  db_ping_ms: { type: 'histogram', help: 'PostgreSQL ping latency (readiness checks), in ms.' },
  queue_waiting: { type: 'gauge', help: 'Background jobs waiting or delayed (all queues).' },
  queue_active: { type: 'gauge', help: 'Background jobs running now (all queues).' },
  queue_failed: { type: 'gauge', help: 'Failed background jobs kept for inspection (all queues).' },
  uptime_seconds: { type: 'gauge', help: 'Process uptime.' },
  process_resident_memory_bytes: { type: 'gauge', help: 'Resident set size.' },
  event_loop_delay_p99_ms: { type: 'gauge', help: 'Event loop delay, 99th percentile.' },
  ocr_queue_depth: { type: 'gauge', help: 'Photos running or waiting for OCR.' },
  ai_breaker_open: { type: 'gauge', help: '1 while the AI circuit breaker is not CLOSED.' },
} as const satisfies Record<string, Definition>;

export type MetricName = keyof typeof CATALOGUE;

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 15_000, 60_000, 120_000];
interface HistogramState {
  counts: number[];
  sum: number;
  count: number;
}

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, HistogramState>>();
  private readonly gauges = new Map<string, () => number>();
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.loop.enable();
    this.registerGauge('uptime_seconds', () => Math.round(process.uptime()));
    this.registerGauge('process_resident_memory_bytes', () => process.memoryUsage().rss);
    this.registerGauge('event_loop_delay_p99_ms', () => {
      const v = this.loop.percentile(99) / 1e6;
      return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
    });
  }

  /** Stops the event-loop sampler (tests and shutdown). */
  close(): void {
    this.loop.disable();
  }

  inc(name: MetricName, labels: Record<string, string> = {}, by = 1): void {
    try {
      const def = CATALOGUE[name] as Definition | undefined;
      if (def?.type !== 'counter') return;
      const key = this.key(def, labels);
      const series = this.series(this.counters, name);
      series.set(key, (series.get(key) ?? 0) + by);
    } catch {
      /* a metric must never break the caller */
    }
  }

  /** Records a duration (ms) into a histogram. */
  observe(name: MetricName, valueMs: number, labels: Record<string, string> = {}): void {
    try {
      const def = CATALOGUE[name] as Definition | undefined;
      if (def?.type !== 'histogram' || !Number.isFinite(valueMs) || valueMs < 0) return;
      const key = this.key(def, labels);
      const series = this.series(this.histograms, name);
      let h = series.get(key);
      if (!h) {
        h = { counts: new Array<number>(BUCKETS_MS.length).fill(0), sum: 0, count: 0 };
        series.set(key, h);
      }
      BUCKETS_MS.forEach((le, i) => {
        if (valueMs <= le) h.counts[i] += 1;
      });
      h.sum += valueMs;
      h.count += 1;
    } catch {
      /* ignore */
    }
  }

  /** Gauges are read when /metrics is rendered. */
  registerGauge(name: MetricName, read: () => number): void {
    if ((CATALOGUE[name] as Definition).type === 'gauge') this.gauges.set(name, read);
  }

  /** Times an async operation into a histogram, whatever its outcome. */
  async time<T>(name: MetricName, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      this.observe(name, performance.now() - started);
    }
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, def] of Object.entries(CATALOGUE) as Array<[MetricName, Definition]>) {
      const body: string[] = [];
      if (def.type === 'counter') {
        for (const [labels, value] of this.counters.get(name) ?? []) {
          body.push(`${name}${labels} ${value}`);
        }
      } else if (def.type === 'histogram') {
        for (const [labels, h] of this.histograms.get(name) ?? []) {
          const inner = labels.length > 2 ? `${labels.slice(1, -1)},` : '';
          BUCKETS_MS.forEach((le, i) =>
            body.push(`${name}_bucket{${inner}le="${le}"} ${h.counts[i]}`),
          );
          body.push(`${name}_bucket{${inner}le="+Inf"} ${h.count}`);
          body.push(`${name}_sum${labels} ${Math.round(h.sum * 1000) / 1000}`);
          body.push(`${name}_count${labels} ${h.count}`);
        }
      } else {
        const read = this.gauges.get(name);
        if (read) {
          try {
            body.push(`${name} ${read()}`);
          } catch {
            /* an unreadable gauge is omitted */
          }
        }
      }
      if (body.length === 0) continue;
      lines.push(`# HELP ${name} ${def.help}`, `# TYPE ${name} ${def.type}`, ...body);
    }
    return `${lines.join('\n')}\n`;
  }

  private series<V>(store: Map<string, Map<string, V>>, name: string): Map<string, V> {
    let s = store.get(name);
    if (!s) {
      s = new Map<string, V>();
      store.set(name, s);
    }
    return s;
  }

  /**
   * `{a="x",b="y"}` with only declared labels and declared values (anything else becomes "other"), so the
   * number of series per metric is bounded by the declared sets.
   */
  private key(def: Definition, labels: Record<string, string>): string {
    const parts: string[] = [];
    for (const [label, allowed] of Object.entries(def.labels ?? {})) {
      const raw = labels[label];
      const value = raw !== undefined && allowed.includes(raw) ? raw : 'other';
      parts.push(`${label}="${value}"`);
    }
    return parts.length ? `{${parts.join(',')}}` : '';
  }
}

/** The peer address of the TCP connection (not a header, so it cannot be spoofed by the client). */
export const isLoopbackPeer = (address: string | undefined): boolean =>
  address !== undefined && /^(::1|(::ffff:)?127(\.\d{1,3}){3})$/i.test(address);

export const isMetricsHostAllowed = (host: string | undefined): boolean =>
  host !== undefined && /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d{1,5})?$/i.test(host.trim());
