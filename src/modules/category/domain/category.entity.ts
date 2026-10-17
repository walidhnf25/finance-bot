import { TransactionType } from 'src/shared/domain/enums';

export interface CategoryEntity {
  id: string;
  /** null => system/global category. */
  userId: string | null;
  name: string;
  type: TransactionType;
  icon: string | null;
  isSystem: boolean;
  createdAt: Date;
}

export interface CreateCategoryInput {
  userId?: string | null;
  name: string;
  type: TransactionType;
  icon?: string | null;
  isSystem?: boolean;
}

export interface FindByKeywordOptions {
  /** Restrict to this transaction type when provided. */
  type?: TransactionType;
  /** Include this user's custom categories in addition to system ones. */
  userId?: string | null;
}
