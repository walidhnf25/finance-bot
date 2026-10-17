import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { MetricsService } from 'src/modules/observability/metrics.service';
import { JobQueue, QUEUE_NAMES } from 'src/modules/queue/domain/job-queue';

export interface RetentionPolicy {
  /** How often the job runs. */
  intervalHours: number;
  /** CANCELLED / EXPIRED receipt drafts are deleted after this many days (0 = keep forever). */
  receiptDraftDays: number;
  /** Audit events are deleted after this many days (0 = keep forever). */
  auditDays: number;
}
export const RETENTION_POLICY = Symbol('RETENTION_POLICY');
export const RETENTION_JOB = 'retention';

export interface RetentionReport {
  expiredDrafts: number;
  deletedDrafts: number;
  deletedConversations: number;
  deletedAuditEvents: number;
}

const DAY_MS = 86_400_000;
/** Conversation rows older than this past their own expiry carry no information worth keeping. */
const CONVERSATION_GRACE_DAYS = 7;
const FIRST_RUN_DELAY_MS = 60_000;

/**
 * Keeps the database from filling with leftovers. It removes only what is safe to remove and never
 * touches the financial record:
 *
 *   touched   receipt drafts that were never confirmed (PENDING past their expiry -> EXPIRED; CANCELLED and
 *             EXPIRED older than the retention window -> deleted), long-expired conversation state, and
 *             old audit events.
 *   NEVER     users, transactions, transfers, budgets, categories, and CONFIRMED receipt drafts (they are
 *             part of a transaction's history).
 *
 * Every step is independent: one failing step is logged and the others still run. A run never overlaps
 * another, never throws, and does nothing under the test runner (tests call {@link runOnce}).
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RETENTION_POLICY) private readonly policy: RetentionPolicy,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly jobs?: JobQueue,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    if (this.jobs?.enabled) {
      // With a queue the job is a repeatable BullMQ job (one schedule however many processes ask for it);
      // if Redis cannot be reached to register it, the in-process timer below takes over.
      this.jobs.registerHandler(
        QUEUE_NAMES.maintenance,
        RETENTION_JOB,
        async () => {
          await this.runOnce();
        },
        { timeoutMs: 10 * 60_000, concurrency: 1 },
      );
      this.jobs
        .scheduleEvery(
          QUEUE_NAMES.maintenance,
          RETENTION_JOB,
          this.policy.intervalHours * 3_600_000,
        )
        .catch(() => {
          this.logger.warn('Queue unreachable; running retention on an in-process timer instead');
          this.startTimer();
        });
      return;
    }
    this.startTimer();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.first = setTimeout(() => void this.runOnce(), FIRST_RUN_DELAY_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.runOnce(), this.policy.intervalHours * 3_600_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now: Date = new Date()): Promise<RetentionReport> {
    const report: RetentionReport = {
      expiredDrafts: 0,
      deletedDrafts: 0,
      deletedConversations: 0,
      deletedAuditEvents: 0,
    };
    if (this.running) return report;
    this.running = true;
    try {
      report.expiredDrafts = await this.step('expire drafts', async () => {
        const { count } = await this.prisma.receiptDraft.updateMany({
          where: { status: 'PENDING', expiresAt: { lt: now } },
          data: { status: 'EXPIRED' },
        });
        this.metrics?.inc('retention_expired_total', {}, count);
        return count;
      });

      if (this.policy.receiptDraftDays > 0) {
        report.deletedDrafts = await this.step('delete old drafts', async () => {
          const cutoff = new Date(now.getTime() - this.policy.receiptDraftDays * DAY_MS);
          const { count } = await this.prisma.receiptDraft.deleteMany({
            // CONFIRMED rows are excluded twice over: by status here, and by the database CHECK that ties
            // them to a transaction.
            where: { status: { in: ['CANCELLED', 'EXPIRED'] }, updatedAt: { lt: cutoff } },
          });
          this.metrics?.inc('retention_deleted_total', { kind: 'receipt_drafts' }, count);
          return count;
        });
      }

      report.deletedConversations = await this.step('delete old conversations', async () => {
        const cutoff = new Date(now.getTime() - CONVERSATION_GRACE_DAYS * DAY_MS);
        const { count } = await this.prisma.conversation.deleteMany({
          where: { expiresAt: { lt: cutoff } },
        });
        this.metrics?.inc('retention_deleted_total', { kind: 'conversations' }, count);
        return count;
      });

      if (this.policy.auditDays > 0) {
        report.deletedAuditEvents = await this.step('delete old audit events', async () => {
          const cutoff = new Date(now.getTime() - this.policy.auditDays * DAY_MS);
          const { count } = await this.prisma.auditEvent.deleteMany({
            where: { createdAt: { lt: cutoff } },
          });
          this.metrics?.inc('retention_deleted_total', { kind: 'audit_events' }, count);
          return count;
        });
      }

      if (Object.values(report).some((n) => n > 0)) this.logger.log(report, 'Retention run');
      return report;
    } finally {
      this.running = false;
    }
  }

  private async step(name: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (err) {
      this.logger.warn(
        { step: name, error: err instanceof Error ? err.name : 'UnknownError' },
        'Retention step failed',
      );
      return 0;
    }
  }
}
