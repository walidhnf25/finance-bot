import { Module } from '@nestjs/common';
import { AuditLogRepository } from './domain/audit-log.repository';
import { DbAuditLogRepository } from './infrastructure/db-audit-log.repository';
import { LoggerAuditLogRepository } from './infrastructure/logger-audit-log.repository';

@Module({
  providers: [
    LoggerAuditLogRepository,
    DbAuditLogRepository,
    { provide: AuditLogRepository, useExisting: DbAuditLogRepository },
  ],
  exports: [AuditLogRepository],
})
export class AuditModule {}
