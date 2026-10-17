import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReceiptModule } from '../receipt/receipt.module';
import { HealthService } from './health.service';

@Module({
  imports: [ReceiptModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
