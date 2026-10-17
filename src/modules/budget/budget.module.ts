import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CategoryModule } from '../category/category.module';
import { TransactionModule } from '../transaction/transaction.module';
import { BudgetService } from './application/budget.service';
import { BudgetRepository } from './domain/budget.repository';
import { PrismaBudgetRepository } from './infrastructure/prisma-budget.repository';

@Module({
  imports: [CategoryModule, TransactionModule, AuditModule],
  providers: [{ provide: BudgetRepository, useClass: PrismaBudgetRepository }, BudgetService],
  exports: [BudgetRepository, BudgetService],
})
export class BudgetModule {}
