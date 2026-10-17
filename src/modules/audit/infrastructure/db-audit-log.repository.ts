import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { AuditLogEntity, AuditMetadata, RecordAuditInput } from '../domain/audit-log.entity';
import { AuditLogRepository } from '../domain/audit-log.repository';
import { LoggerAuditLogRepository } from './logger-audit-log.repository';

/**
 * Actions kept in the database trail: every change to money or to the user's data. Per-message chatter
 * (MESSAGE_IN / MESSAGE_OUT) adds nothing the structured log does not already say, so it stays log-only.
 */
export const STORED_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  'TX_CREATE',
  'TX_EDIT',
  'TX_DELETE',
  'TRANSFER_CREATE',
  'TRANSFER_DELETE',
  'BUDGET_SET',
  'RECEIPT_DRAFT',
  'RECEIPT_CONFIRM',
  'RECEIPT_CANCEL',
  'USER_RESET',
]);

/** Metadata must stay small (the table also enforces 4 KB): ids and kinds only. */
const MAX_METADATA_CHARS = 1_024;
/** One "could not store" warning per minute is enough to see a pending migration or a database outage. */
const WARN_EVERY_MS = 60_000;

/**
 * Audit trail in PostgreSQL, on top of the structured log.
 *
 * Honest limits, so nobody over-trusts it:
 *  - It is BEST EFFORT. Recording is not part of the financial database transaction, so a crash between
 *    the change and the audit write can lose an event, and a failed write never blocks the user's
 *    operation. The authoritative record is the ledger itself (rows with timestamps, idempotency keys and
 *    soft deletes); this trail answers "what happened, to which record, when".
 *  - It is NOT tamper-proof: anyone with database access can edit it.
 *  - It never holds amounts, merchants, receipt text or message text (callers pass ids and kinds).
 */
@Injectable()
export class DbAuditLogRepository extends AuditLogRepository {
  private readonly logger = new Logger('AuditStore');
  private lastWarnAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly log: LoggerAuditLogRepository,
  ) {
    super();
  }

  async record(input: RecordAuditInput): Promise<void> {
    await this.log.record(input);
    if (!STORED_AUDIT_ACTIONS.has(input.action)) return;
    try {
      await this.prisma.auditEvent.create({
        data: {
          userId: input.userId ?? null,
          action: input.action,
          metadata: this.safeMetadata(input.metadata),
        },
      });
    } catch (err) {
      const now = Date.now();
      if (now - this.lastWarnAt >= WARN_EVERY_MS) {
        this.lastWarnAt = now;
        // Class name only: a database message can embed values.
        this.logger.warn(
          { error: err instanceof Error ? err.name : 'UnknownError', action: input.action },
          'Audit event could not be stored (is the latest migration applied?)',
        );
      }
    }
  }

  async findForUser(userId: string, limit = 50): Promise<AuditLogEntity[]> {
    const rows = await this.prisma.auditEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(1, Math.trunc(limit)), 500),
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      action: r.action,
      metadata: (r.metadata as AuditMetadata | null) ?? null,
      createdAt: r.createdAt,
    }));
  }

  private safeMetadata(
    metadata: AuditMetadata | null | undefined,
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    if (!metadata) return Prisma.JsonNull;
    try {
      const text = JSON.stringify(metadata);
      if (text.length > MAX_METADATA_CHARS) return { truncated: true };
      return JSON.parse(text) as Prisma.InputJsonValue;
    } catch {
      return { unserialisable: true };
    }
  }
}
