import { normalizeCommand, toIncomingMessage } from './telegram-update.mapper';
import { TelegramUpdate } from './telegram.types';

function update(overrides: Partial<NonNullable<TelegramUpdate['message']>> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      from: { id: 1001, is_bot: false, first_name: 'Budi', last_name: 'Santoso' },
      chat: { id: 1001, type: 'private' },
      date: 1_784_000_000,
      text: 'beli kopi 25rb',
      ...overrides,
    },
  };
}

describe('toIncomingMessage', () => {
  it('maps a private text message', () => {
    expect(toIncomingMessage(update())).toEqual({
      messageId: '1001:42',
      from: '1001',
      chatId: '1001',
      text: 'beli kopi 25rb',
      senderName: 'Budi Santoso',
      timestamp: new Date(1_784_000_000 * 1000),
    });
  });

  it('falls back to the caption and username', () => {
    const msg = toIncomingMessage(
      update({
        text: undefined,
        caption: 'makan 15rb',
        from: { id: 7, is_bot: false, first_name: '', username: 'budi' },
      }),
    );
    expect(msg?.text).toBe('makan 15rb');
    expect(msg?.senderName).toBe('budi');
  });

  it.each<[string, TelegramUpdate]>([
    ['non-message updates', { update_id: 2 }],
    ['group chats', update({ chat: { id: -5, type: 'group' } })],
    ['other bots', update({ from: { id: 9, is_bot: true, first_name: 'Bot' } })],
    ['empty text', update({ text: '   ' })],
  ])('ignores %s', (_label, input) => {
    expect(toIncomingMessage(input)).toBeNull();
  });
});

describe('normalizeCommand', () => {
  it.each([
    ['/start', 'help'],
    ['/help@FinanceBot', 'help'],
    ['/ringkasan bulan ini', 'ringkasan bulan ini'],
    ['/export@FinanceBot minggu ini', 'export minggu ini'],
    ['beli kopi 25rb', 'beli kopi 25rb'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeCommand(input)).toBe(expected);
  });
});
