import { Module } from '@nestjs/common';
import { CategoryModule } from '../category/category.module';
import { TransactionModule } from '../transaction/transaction.module';
import { CsvExportService } from './application/csv-export.service';
import { ReportService } from './application/report.service';

@Module({
  imports: [TransactionModule, CategoryModule],
  providers: [ReportService, CsvExportService],
  exports: [ReportService, CsvExportService],
})
export class ReportModule {}
