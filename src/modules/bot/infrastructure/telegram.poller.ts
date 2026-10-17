import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UpdateProcessor } from './update-processor';
import { TelegramGateway } from './telegram.gateway';

const POLL_TIMEOUT_SECONDS = 25;
const ERROR_BACKOFF_MS = 5_000;
const RETRY_BACKOFF_MS = 2_000;

/**
 * Default transport: long-polls getUpdates, so the finance bot needs no public URL.
 *
 * Offset rules (this is what prevents lost updates): the offset only moves past an update after
 * it was fully processed (or given up on after the attempt limit, with the user informed). If the
 * process dies mid-update, Telegram redelivers it on the next start, and the idempotency keys on
 * every financial write make the second run harmless.
 */
@Injectable()
export class TelegramPoller implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramPoller.name);
  private readonly enabled: boolean;
  private stopped = false;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly gateway: TelegramGateway,
    private readonly processor: UpdateProcessor,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('telegram.polling', true);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.logger.log('Polling Telegram for updates (no public URL needed)');
    this.loopDone = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await Promise.race([this.loopDone, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  }

  private async loop(): Promise<void> {
    let offset = 0;
    while (!this.stopped) {
      try {
        const updates = await this.gateway.getUpdates(offset, POLL_TIMEOUT_SECONDS);
        for (const update of updates) {
          // Re-run the same update until it is done; only then move the offset forward.
          while ((await this.processor.process(update)) === 'retry' && !this.stopped) {
            await sleep(RETRY_BACKOFF_MS);
          }
          if (this.stopped) return;
          offset = update.update_id + 1;
        }
      } catch (err) {
        // A 409 means a webhook is set for this bot: remove it with deleteWebhook first.
        this.logger.error(
          { error: err instanceof Error ? err.name : 'UnknownError' },
          'getUpdates failed; retrying shortly',
        );
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
