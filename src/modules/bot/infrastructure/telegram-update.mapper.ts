import { ImageAttachment, IncomingMessage } from '../domain/messaging.gateway.port';
import { TelegramUpdate } from './telegram.types';

/** Bot commands that should open the help menu. */
const HELP_COMMANDS = new Set(['start', 'help', 'menu']);

/**
 * Telegram clients send commands as `/name` or `/name@BotName`. Map the menu
 * commands to "help" and otherwise drop the slash so `/ringkasan bulan ini`
 * reads like the plain-text command the parser already understands.
 */
export function normalizeCommand(text: string): string {
  const match = /^\/([a-z0-9_]+)(?:@\w+)?(.*)$/is.exec(text);
  if (!match) return text;
  const [, command, rest] = match;
  if (HELP_COMMANDS.has(command.toLowerCase())) return 'help';
  return `${command}${rest}`.trim();
}

/** The largest photo, or a document that claims to be an image. */
function toAttachment(message: NonNullable<TelegramUpdate['message']>): ImageAttachment | null {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo.reduce((a, b) =>
      b.width * b.height > a.width * a.height ? b : a,
    );
    return {
      kind: 'image',
      fileId: largest.file_id,
      sizeBytes: largest.file_size,
      mimeType: 'image/jpeg',
    };
  }
  if (message.document?.mime_type?.toLowerCase().startsWith('image/')) {
    const d = message.document;
    return { kind: 'image', fileId: d.file_id, sizeBytes: d.file_size, mimeType: d.mime_type };
  }
  return null;
}

/**
 * Convert a Telegram update into the platform-neutral {@link IncomingMessage}.
 * Returns null for anything the bot ignores: non-message updates, group chats,
 * other bots and messages without text.
 */
export function toIncomingMessage(update: TelegramUpdate): IncomingMessage | null {
  const message = update.message;
  if (!message?.from || message.from.is_bot) return null;
  if (message.chat.type !== 'private') return null;

  const text = normalizeCommand((message.text ?? message.caption ?? '').trim());
  const attachment = toAttachment(message);
  if (!text && !attachment) return null;

  const { from, chat } = message;
  const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username;

  return {
    // message_id is only unique within a chat.
    messageId: `${chat.id}:${message.message_id}`,
    from: String(from.id),
    chatId: String(chat.id),
    text,
    ...(attachment ? { attachment } : {}),
    senderName,
    timestamp: new Date(message.date * 1000),
  };
}
