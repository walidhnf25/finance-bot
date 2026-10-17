import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CategoryModule } from '../category/category.module';
import { TransactionService } from './application/transaction.service';
import { TransactionRepository } from './domain/transaction.repository';
import { PrismaTransactionRepository } from './infrastructure/prisma-transaction.repository';

@Module({
  imports: [CategoryModule, AuditModule],
  providers: [
    { provide: TransactionRepository, useClass: PrismaTransactionRepository },
    TransactionService,
  ],
  exports: [TransactionRepository, TransactionService],
})
export class TransactionModule {}
