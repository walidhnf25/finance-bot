import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ResetUserDataService } from './application/reset-user-data.service';
import { UserDataResetRepository } from './domain/user-data-reset.repository';
import { UserRepository } from './domain/user.repository';
import { PrismaUserDataResetRepository } from './infrastructure/prisma-user-data-reset.repository';
import { PrismaUserRepository } from './infrastructure/prisma-user.repository';

/**
 * User module. Binds the UserRepository port to its PostgreSQL implementation and
 * provides the per-user data reset use-case.
 */
@Module({
  imports: [AuditModule],
  providers: [
    { provide: UserRepository, useClass: PrismaUserRepository },
    { provide: UserDataResetRepository, useClass: PrismaUserDataResetRepository },
    ResetUserDataService,
  ],
  exports: [UserRepository, ResetUserDataService],
})
export class UserModule {}
