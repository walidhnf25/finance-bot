import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { UpdateProcessor } from './update-processor';
import { TelegramUpdate } from './telegram.types';

/**
 * Optional webhook entry (only when TELEGRAM_POLLING=false, e.g. behind a tunnel). The default
 * polling mode uses long polling and this endpoint answers 404.
 *
 * Fail-closed rules:
 *  - the secret header is ALWAYS verified; a missing, wrong or empty header is rejected, and a
 *    server without a configured secret rejects everything (startup validation also refuses to
 *    boot in webhook mode without one);
 *  - an update that fails to process is answered with 503 so Telegram redelivers it (safe: writes
 *    are idempotent); after the attempt limit the user is told and the update is acknowledged.
 */
@ApiExcludeController()
@Controller('telegram')
export class TelegramWebhookController {
  private readonly secret: string;
  private readonly polling: boolean;

  constructor(
    private readonly processor: UpdateProcessor,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('telegram.webhookSecret', '');
    this.polling = config.get<boolean>('telegram.polling', true);
  }

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Body() update: TelegramUpdate,
    @Headers('x-telegram-bot-api-secret-token') secretHeader?: string,
  ): Promise<{ ok: true }> {
    if (this.polling) throw new NotFoundException();
    if (!this.secret || !this.matchesSecret(secretHeader)) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    if (typeof update?.update_id !== 'number') throw new BadRequestException('Invalid update');

    if ((await this.processor.process(update)) === 'retry') {
      throw new ServiceUnavailableException('Temporarily unable to process the update');
    }
    return { ok: true };
  }

  private matchesSecret(header: string | undefined): boolean {
    const expected = Buffer.from(this.secret);
    const actual = Buffer.from(header ?? '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
