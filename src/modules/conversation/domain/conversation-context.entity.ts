import { ConversationState } from 'src/shared/domain/enums';

export type ConversationPayload = Record<string, unknown>;

export interface ConversationContextEntity {
  id: string;
  userId: string;
  state: ConversationState;
  payload: ConversationPayload | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetContextInput {
  userId: string;
  state: ConversationState;
  payload?: ConversationPayload | null;
  /** When the pending context should expire (TTL). */
  expiresAt?: Date | null;
}
