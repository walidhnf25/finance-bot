import { CreateUserInput, UpdateUserInput, UserEntity } from './user.entity';

/**
 * Port for user persistence. The abstract class doubles as the DI token, so
 * consumers depend on this contract — never on the storage implementation.
 */
export abstract class UserRepository {
  abstract findById(id: string): Promise<UserEntity | null>;
  abstract findByTelegramId(telegramId: string): Promise<UserEntity | null>;

  /** Returns the existing user or creates one; `created` signals onboarding. */
  abstract findOrCreate(input: CreateUserInput): Promise<{ user: UserEntity; created: boolean }>;

  abstract update(id: string, patch: UpdateUserInput): Promise<UserEntity>;
}
