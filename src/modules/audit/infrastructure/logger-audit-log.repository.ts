import { Injectable, Logger } from '@nestjs/common';
import { AuditLogEntity, RecordAuditInput } from '../domain/audit-log.entity';
import { AuditLogRepository } from '../domain/audit-log.repository';

/**
 * Writes the audit trail to the structured application log. Events carry ids, types and sizes,
 * never message text or amounts (callers are responsible for that; see the privacy test).
 */
@Injectable()
export class LoggerAuditLogRepository extends AuditLogRepository {
  private readonly logger = new Logger('Audit');

  record(input: RecordAuditInput): Promise<void> {
    this.logger.log(
      { userId: input.userId ?? null, action: input.action, metadata: input.metadata ?? null },
      input.action,
    );
    return Promise.resolve();
  }

  findForUser(): Promise<AuditLogEntity[]> {
    return Promise.resolve([]);
  }
}
