import { Global, Module } from '@nestjs/common';
import { JobQueue } from './domain/job-queue';
import { BullJobQueue } from './infrastructure/bull-job-queue';

/**
 * Optional background queues. Always present as a provider, but inert unless REDIS_URL is set
 * (`JobQueue.enabled` is false and callers keep their in-process path).
 */
@Global()
@Module({
  providers: [BullJobQueue, { provide: JobQueue, useExisting: BullJobQueue }],
  exports: [JobQueue],
})
export class QueueModule {}
