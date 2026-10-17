/**
 * Wipes ALL financial data of one user in a single all-or-nothing step (transactions, transfers, budgets,
 * receipt drafts, conversation state and the user's own categories). System categories and the user row
 * stay. Every delete is scoped by `userId`.
 */
export abstract class UserDataResetRepository {
  abstract wipe(userId: string): Promise<void>;
}
