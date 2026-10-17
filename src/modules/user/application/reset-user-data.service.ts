import { Injectable, Logger, Optional } from '@nestjs/common';
import { AuditLogRepository } from 'src/modules/audit/domain/audit-log.repository';
import { UserDataResetRepository } from '../domain/user-data-reset.repository';

/**
 * Wipes all financial data belonging to one user so they can start over. The wipe is one database
 * transaction (all or nothing) and every delete is scoped by `userId`, so it can never touch another
 * user's rows. System categories and the user record itself are kept. The act is recorded in the audit
 * trail, which (having no foreign key to the user) outlives the wipe.
 */
@Injectable()
export class ResetUserDataService {
  private readonly logger = new Logger(ResetUserDataService.name);

  constructor(
    private readonly data: UserDataResetRepository,
    @Optional() private readonly audit?: AuditLogRepository,
  ) {}

  async reset(userId: string): Promise<void> {
    await this.data.wipe(userId);
    this.logger.log({ userId }, 'User data reset');
    await this.audit?.record({ userId, action: 'USER_RESET' });
  }
}
