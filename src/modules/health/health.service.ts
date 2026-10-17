import { Injectable, Optional } from '@nestjs/common';
import { MetricsService } from '../observability/metrics.service';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from 'src/database/prisma.service';
import { AiHealthProbe, AiHealthStatus } from './ai-health.probe';
import { OcrHealthProbe } from './ocr-health.probe';
import { JobQueue } from '../queue/domain/job-queue';

export type CheckStatus = 'up' | 'down' | 'degraded' | 'skipped';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, { status: CheckStatus; detail?: string }>;
}

const READY_CACHE_MS = 5_000;

/**
 * Liveness vs readiness.
 *  - live():  the process is running. Touches no dependency, so a database outage never makes a
 *             supervisor restart a healthy process.
 *  - ready(): the process can do its job: PostgreSQL answers AND every migration on disk has been
 *             applied. The AI is reported as `degraded` (the bot still works for text), it
 *             never makes the app "not ready".
 * Details are fixed strings: no connection strings, credentials or error bodies ever leave here.
 */
@Injectable()
export class HealthService {
  private readyCache: { at: number; report: HealthReport } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly ai?: AiHealthProbe,
    @Optional() private readonly ocr?: OcrHealthProbe,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly queue?: JobQueue,
  ) {}

  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  async ready(): Promise<HealthReport> {
    if (this.readyCache && Date.now() - this.readyCache.at < READY_CACHE_MS) {
      return this.readyCache.report;
    }

    const checks: HealthReport['checks'] = {};
    try {
      const pingStarted = performance.now();
      await this.prisma.ping();
      this.metrics?.observe('db_ping_ms', performance.now() - pingStarted);
      checks.database = { status: 'up' };
      checks.migrations = await this.checkMigrations();
    } catch {
      checks.database = { status: 'down', detail: 'PostgreSQL is not reachable' };
      checks.migrations = { status: 'skipped' };
    }

    if (this.ai) {
      const ai: AiHealthStatus = await this.ai.check();
      checks.ai = { status: ai.available ? 'up' : 'degraded', detail: ai.detail };
    } else {
      checks.ai = { status: 'skipped' };
    }

    // Optional capability: without the OCR language data receipt photos cannot be read, but every other
    // feature works, so this is `degraded`, never `down`.
    if (this.ocr) {
      const ocr = this.ocr.check();
      checks.ocr = { status: ocr.available ? 'up' : 'degraded', detail: ocr.detail };
    } else {
      checks.ocr = { status: 'skipped' };
    }

    // Optional queue backend: unreachable Redis is `degraded` (receipts are then read in-process), never `down`.
    if (this.queue?.enabled) {
      const q = await this.queue.check();
      checks.queue =
        q.status === 'up'
          ? { status: 'up' }
          : { status: 'degraded', detail: 'Redis is not reachable; receipts are read in-process' };
    } else {
      checks.queue = { status: 'skipped', detail: 'queues are off (REDIS_URL empty)' };
    }

    const down = checks.database.status === 'down' || checks.migrations.status === 'down';
    const degraded = Object.values(checks).some((c) => c.status === 'degraded');
    const report: HealthReport = { status: down ? 'down' : degraded ? 'degraded' : 'ok', checks };
    this.readyCache = { at: Date.now(), report };
    return report;
  }

  /** Every migration folder on disk must be recorded as finished in `_prisma_migrations`. */
  private async checkMigrations(): Promise<{ status: CheckStatus; detail?: string }> {
    let onDisk: string[];
    try {
      onDisk = readdirSync(join(process.cwd(), 'prisma', 'migrations'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return { status: 'skipped', detail: 'migration folder not found' };
    }
    const rows = await this.prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    const applied = new Set(rows.map((r) => r.migration_name));
    const pending = onDisk.filter((name) => !applied.has(name));
    return pending.length === 0
      ? { status: 'up' }
      : {
          status: 'down',
          detail: `${pending.length} migration(s) not applied: run "npm run prisma:deploy"`,
        };
  }
}
