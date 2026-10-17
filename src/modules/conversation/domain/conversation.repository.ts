import { ConversationContextEntity, SetContextInput } from './conversation-context.entity';

export abstract class ConversationRepository {
  /**
   * Active (non-expired, non-IDLE) context for the user, or null. Implementations
   * treat an expired context as absent.
   */
  abstract getActive(userId: string, now: Date): Promise<ConversationContextEntity | null>;

  /** Create or replace the user's conversation context (1:1). */
  abstract set(input: SetContextInput): Promise<ConversationContextEntity>;

  /** Reset the user's context back to IDLE and drop the payload. */
  abstract clear(userId: string): Promise<void>;
}
