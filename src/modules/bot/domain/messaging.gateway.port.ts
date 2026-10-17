/** A normalized inbound message, decoupled from the chat platform's wire format. */
/** An image the user sent (e.g. a receipt photo). Only a reference: bytes are fetched on demand. */
export interface ImageAttachment {
  kind: 'image';
  /** Platform file reference used to download the bytes. */
  fileId: string;
  /** Size announced by the platform, when known (checked again after download). */
  sizeBytes?: number;
  /** MIME type announced by the platform. Never trusted: content is validated after download. */
  mimeType?: string;
}

export interface IncomingMessage {
  /** Provider message id, unique across chats — used for idempotency. */
  messageId: string;
  /** Stable sender identifier (Telegram user id). Used as the user key. */
  from: string;
  /** Chat id to reply to. */
  chatId: string;
  /** Plain text body (the caption for an attachment, possibly empty). */
  text: string;
  /** At most one image per message is processed. */
  attachment?: ImageAttachment;
  /** Sender's display name, if available. */
  senderName?: string;
  timestamp: Date;
}

export type IncomingMessageHandler = (message: IncomingMessage) => Promise<void>;

/**
 * Port abstracting the chat transport. The abstract class doubles as the DI
 * token so the handlers never depend on Telegram directly — another platform
 * adapter could replace it without touching them.
 */
export abstract class MessagingGateway {
  /** Register the inbound message handler (called once at startup). */
  abstract onMessage(handler: IncomingMessageHandler): void;

  abstract sendText(to: string, text: string): Promise<void>;

  /**
   * Download an attachment, never returning more than `maxBytes` (throws ResponseTooLargeError).
   */
  abstract downloadFile(fileId: string, maxBytes: number): Promise<Buffer>;

  abstract sendDocument(
    to: string,
    content: Buffer,
    filename: string,
    mimetype?: string,
  ): Promise<void>;
}
