import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { UserDataResetRepository } from '../domain/user-data-reset.repository';

/** One database transaction: either every table is cleared for this user or none is. */
@Injectable()
export class PrismaUserDataResetRepository extends UserDataResetRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async wipe(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.transaction.deleteMany({ where: { userId } }),
      this.prisma.transfer.deleteMany({ where: { userId } }),
      this.prisma.budget.deleteMany({ where: { userId } }),
      this.prisma.receiptDraft.deleteMany({ where: { userId } }),
      this.prisma.conversation.deleteMany({ where: { userId } }),
      this.prisma.category.deleteMany({ where: { userId } }),
    ]);
  }
}
