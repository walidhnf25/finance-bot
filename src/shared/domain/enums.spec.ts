import * as Db from '@prisma/client';
import {
  activeWallets,
  BudgetPeriod,
  ConversationState,
  TransactionType,
  Wallet,
  WalletMode,
} from './enums';

/**
 * The domain enums and the PostgreSQL enums are separate declarations that must list the same
 * values; repositories rely on that when they cast between them. This test fails the moment
 * one side changes without the other.
 */
describe('domain enums match the Prisma (PostgreSQL) enums', () => {
  const same = (domain: object, db: object) =>
    expect(Object.values(domain).sort()).toEqual(Object.values(db).sort());

  it('TransactionType', () => same(TransactionType, Db.TransactionType));
  it('Wallet', () => same(Wallet, Db.Wallet));
  it('WalletMode', () => same(WalletMode, Db.WalletMode));
  it('BudgetPeriod', () => same(BudgetPeriod, Db.BudgetPeriod));
  it('ConversationState', () => same(ConversationState, Db.ConversationState));
});

describe('activeWallets', () => {
  it('maps each mode to its wallets; an unchosen mode shows both', () => {
    expect(activeWallets(WalletMode.CASH)).toEqual([Wallet.CASH]);
    expect(activeWallets(WalletMode.DIGITAL)).toEqual([Wallet.DIGITAL]);
    expect(activeWallets(WalletMode.BOTH)).toEqual([Wallet.CASH, Wallet.DIGITAL]);
    expect(activeWallets(null)).toEqual([Wallet.CASH, Wallet.DIGITAL]);
  });
});
