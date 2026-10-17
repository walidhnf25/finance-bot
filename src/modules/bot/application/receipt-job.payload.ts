import { RejectedJobError } from 'src/modules/queue/domain/job-queue';

/**
 * What a queued "read this receipt photo" job carries. A REFERENCE only: ids and a Telegram file id, never the
 * picture, its text or any amount. Redis is outside the trust boundary (anyone who can write to it can write a
 * job), so the CONSUMER validates every job again; the producer's TypeScript type proves nothing.
 */
export interface ReceiptJobPayload {
  userId: string;
  chatId: string;
  messageId: string;
  fileId: string;
  sizeBytes?: number;
  /** ISO time the message arrived; becomes the message timestamp. */
  receivedAt: string;
  correlationId?: string;
}

const ALLOWED_KEYS = new Set([
  'userId',
  'chatId',
  'messageId',
  'fileId',
  'sizeBytes',
  'receivedAt',
  'correlationId',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_ID = /^\d{1,16}$/; // private chats only (positive ids; Telegram ids fit in 52 bits)
const MESSAGE_ID = /^[A-Za-z0-9:_-]{1,64}$/;
const FILE_ID = /^[A-Za-z0-9_-]{8,200}$/;
const MAX_FILE_BYTES = 50 * 1_048_576;
const MAX_AGE_MS = 7 * 24 * 3_600_000;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

/** Returns the payload or throws RejectedJobError with a short code (the payload is never echoed). */
export function parseReceiptJob(data: unknown, now: Date = new Date()): ReceiptJobPayload {
  if (!isPlainObject(data)) throw new RejectedJobError('not_an_object');
  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEYS.has(key)) throw new RejectedJobError('unexpected_field');
  }
  const { userId, chatId, messageId, fileId, sizeBytes, receivedAt, correlationId } = data;
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new RejectedJobError('bad_user');
  if (typeof chatId !== 'string' || !CHAT_ID.test(chatId)) throw new RejectedJobError('bad_chat');
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) {
    throw new RejectedJobError('bad_message');
  }
  if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) throw new RejectedJobError('bad_file');
  if (
    sizeBytes !== undefined &&
    (typeof sizeBytes !== 'number' ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > MAX_FILE_BYTES)
  ) {
    throw new RejectedJobError('bad_size');
  }
  if (typeof receivedAt !== 'string') throw new RejectedJobError('bad_time');
  const at = new Date(receivedAt);
  if (Number.isNaN(at.getTime()) || Math.abs(now.getTime() - at.getTime()) > MAX_AGE_MS) {
    throw new RejectedJobError('bad_time');
  }
  if (
    correlationId !== undefined &&
    (typeof correlationId !== 'string' || correlationId.length > 100)
  ) {
    throw new RejectedJobError('bad_correlation');
  }
  return { userId, chatId, messageId, fileId, sizeBytes, receivedAt, correlationId };
}

/** BullMQ forbids ':' in custom job ids; keep the id readable and stable per Telegram message. */
export const receiptJobId = (messageId: string): string =>
  `receipt-${messageId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
