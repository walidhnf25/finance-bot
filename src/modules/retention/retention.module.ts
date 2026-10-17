import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  RETENTION_POLICY,
  RetentionPolicy,
  RetentionService,
} from './infrastructure/retention.service';

/** Scheduled clean-up of leftovers (unconfirmed receipt drafts, old conversation state, old audit events). */
@Module({
  providers: [
    {
      provide: RETENTION_POLICY,
      useFactory: (config: ConfigService) => config.getOrThrow<RetentionPolicy>('retention'),
      inject: [ConfigService],
    },
    RetentionService,
  ],
  exports: [RetentionService],
})
export class RetentionModule {}
