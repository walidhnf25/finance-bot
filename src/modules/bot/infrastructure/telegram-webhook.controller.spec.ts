import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UpdateProcessor } from './update-processor';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { TelegramUpdate } from './telegram.types';

const SECRET = 'a-strong-webhook-secret-123';
const update: TelegramUpdate = { update_id: 7 };

function controller(
  config: Record<string, unknown>,
  process = jest.fn().mockResolvedValue('done'),
) {
  const cfg = {
    get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback),
  } as ConfigService;
  return {
    ctrl: new TelegramWebhookController({ process } as unknown as UpdateProcessor, cfg),
    process,
  };
}

describe('TelegramWebhookController', () => {
  const webhookMode = { 'telegram.polling': false, 'telegram.webhookSecret': SECRET };

  describe('secret verification (security regression tests)', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['wrong', 'nope'],
      ['longer', SECRET + 'x'],
      ['shorter', SECRET.slice(1)],
      ['case changed', SECRET.toUpperCase()],
    ])('rejects a %s header and never processes the update', async (_name, header) => {
      const { ctrl, process } = controller(webhookMode);
      await expect(ctrl.webhook(update, header)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(process).not.toHaveBeenCalled();
    });

    it('accepts exactly the configured secret', async () => {
      const { ctrl, process } = controller(webhookMode);
      await expect(ctrl.webhook(update, SECRET)).resolves.toEqual({ ok: true });
      expect(process).toHaveBeenCalledWith(update);
    });

    it('fails CLOSED when no secret is configured: it does not skip verification', async () => {
      const { ctrl, process } = controller({
        'telegram.polling': false,
        'telegram.webhookSecret': '',
      });
      await expect(ctrl.webhook(update, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(ctrl.webhook(update, '')).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(ctrl.webhook(update, 'anything')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(process).not.toHaveBeenCalled();
    });
  });

  it('does not exist in polling mode', async () => {
    const { ctrl, process } = controller({
      'telegram.polling': true,
      'telegram.webhookSecret': SECRET,
    });
    await expect(ctrl.webhook(update, SECRET)).rejects.toBeInstanceOf(NotFoundException);
    expect(process).not.toHaveBeenCalled();
  });

  it.each([[null], [undefined], [{}], [{ update_id: '7' }], [[]]])(
    'rejects a malformed body %j',
    async (body) => {
      const { ctrl, process } = controller(webhookMode);
      await expect(ctrl.webhook(body as unknown as TelegramUpdate, SECRET)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(process).not.toHaveBeenCalled();
    },
  );

  it('answers 503 when the update should be retried, so Telegram redelivers it', async () => {
    const { ctrl } = controller(webhookMode, jest.fn().mockResolvedValue('retry'));
    await expect(ctrl.webhook(update, SECRET)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('acknowledges an update that was given up on (the user was told)', async () => {
    const { ctrl } = controller(webhookMode, jest.fn().mockResolvedValue('done'));
    await expect(ctrl.webhook(update, SECRET)).resolves.toEqual({ ok: true });
  });
});
