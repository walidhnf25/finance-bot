import { Wallet } from 'src/shared/domain/enums';
import {
  CreateTransferInput,
  TransferEntity,
  TransferRange,
  TransferTotals,
} from './transfer.entity';

/** Port for wallet-to-wallet transfers. The abstract class doubles as the DI token. */
export abstract class TransferRepository {
  /** Returns null when this user already recorded a transfer under the same message id. */
  abstract create(input: CreateTransferInput): Promise<TransferEntity | null>;

  /** Most recent non-deleted transfer for the user. */
  abstract findLatestForUser(userId: string): Promise<TransferEntity | null>;

  /** Throws when the transfer does not exist, is deleted, or belongs to someone else. */
  abstract softDelete(userId: string, id: string): Promise<void>;

  /** Idempotency guard for inbound chat messages. */
  abstract existsByMessageId(userId: string, messageId: string): Promise<boolean>;

  /** Non-deleted transfers within the range, oldest first. */
  abstract findManyInRange(userId: string, range: TransferRange): Promise<TransferEntity[]>;

  /** Money received/sent per wallet; all time when no range is given. */
  abstract sumByWallet(
    userId: string,
    range?: TransferRange,
  ): Promise<Record<Wallet, TransferTotals>>;

  /** True once the user has recorded at least one transfer. */
  abstract hasAny(userId: string): Promise<boolean>;
}
