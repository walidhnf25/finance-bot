import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CategoryModule } from '../category/category.module';
import { TransactionModule } from '../transaction/transaction.module';
import { UserModule } from '../user/user.module';
import { WalletService } from './application/wallet.service';
import { TransferRepository } from './domain/transfer.repository';
import { PrismaTransferRepository } from './infrastructure/prisma-transfer.repository';

@Module({
  imports: [TransactionModule, UserModule, CategoryModule, AuditModule],
  providers: [{ provide: TransferRepository, useClass: PrismaTransferRepository }, WalletService],
  exports: [WalletService],
})
export class WalletModule {}
