import { AuditLogEntity, RecordAuditInput } from './audit-log.entity';

export abstract class AuditLogRepository {
  /** Append an audit entry (never throws on best-effort logging paths). */
  abstract record(input: RecordAuditInput): Promise<void>;

  abstract findForUser(userId: string, limit?: number): Promise<AuditLogEntity[]>;
}
