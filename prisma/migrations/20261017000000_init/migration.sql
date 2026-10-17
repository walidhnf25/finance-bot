-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "Wallet" AS ENUM ('CASH', 'DIGITAL');

-- CreateEnum
CREATE TYPE "WalletMode" AS ENUM ('CASH', 'DIGITAL', 'BOTH');

-- CreateEnum
CREATE TYPE "BudgetPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('IDLE', 'AWAITING_AMOUNT', 'AWAITING_WALLET', 'AWAITING_WALLET_MODE', 'AWAITING_OPENING_BALANCE', 'AWAITING_CATEGORY', 'AWAITING_CONFIRM', 'AWAITING_DELETE_CONFIRM', 'AWAITING_RECEIPT_CONFIRM');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "chat_id" TEXT,
    "display_name" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    "is_onboarded" BOOLEAN NOT NULL DEFAULT false,
    "wallet_mode" "WalletMode",
    "default_wallet" "Wallet",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "name" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "icon" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "keywords" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category_id" TEXT,
    "type" "TransactionType" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "description" TEXT NOT NULL,
    "note" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "source_message" TEXT,
    "idempotency_key" TEXT,
    "wallet" "Wallet",
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "from_wallet" "Wallet" NOT NULL,
    "to_wallet" "Wallet" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "note" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "idempotency_key" TEXT,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category_id" TEXT,
    "scope_key" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "period" "BudgetPeriod" NOT NULL,
    "alert_threshold" INTEGER NOT NULL DEFAULT 80,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "state" "ConversationState" NOT NULL DEFAULT 'IDLE',
    "payload" JSONB,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_drafts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "image_sha256" TEXT NOT NULL,
    "extraction" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "transaction_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "receipt_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");

-- CreateIndex
CREATE INDEX "categories_type_idx" ON "categories"("type");

-- CreateIndex
CREATE UNIQUE INDEX "categories_user_id_name_type_key" ON "categories"("user_id", "name", "type");

-- CreateIndex
CREATE INDEX "transactions_user_id_occurred_at_idx" ON "transactions"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "transactions_user_id_created_at_idx" ON "transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "transactions_user_id_note_idx" ON "transactions"("user_id", "note");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_user_id_idempotency_key_key" ON "transactions"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "transfers_user_id_occurred_at_idx" ON "transfers"("user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_user_id_idempotency_key_key" ON "transfers"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_user_id_scope_key_period_key" ON "budgets"("user_id", "scope_key", "period");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_user_id_key" ON "conversations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_drafts_transaction_id_key" ON "receipt_drafts"("transaction_id");

-- CreateIndex
CREATE INDEX "receipt_drafts_user_id_status_idx" ON "receipt_drafts"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_drafts_user_id_image_sha256_key" ON "receipt_drafts"("user_id", "image_sha256");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Integrity rules that Prisma's schema language cannot express. They are enforced by the database
-- itself, so no application bug (or direct SQL) can store an invalid financial row.
-- ---------------------------------------------------------------------------------------------

-- Exact positive money; upper bound keeps every sum comfortably inside BIGINT (10^15 minor units
-- = 10^13 rupiah per row).
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_amount_positive_chk" CHECK ("amount_minor" > 0 AND "amount_minor" <= 1000000000000000);

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_amount_positive_chk" CHECK ("amount_minor" > 0 AND "amount_minor" <= 1000000000000000),
  ADD CONSTRAINT "transfers_distinct_wallets_chk" CHECK ("from_wallet" <> "to_wallet");

ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_amount_positive_chk" CHECK ("amount_minor" > 0 AND "amount_minor" <= 1000000000000000),
  ADD CONSTRAINT "budgets_threshold_range_chk" CHECK ("alert_threshold" BETWEEN 1 AND 100),
  ADD CONSTRAINT "budgets_scope_matches_category_chk" CHECK (
    ("category_id" IS NULL AND "scope_key" = 'ALL') OR ("category_id" IS NOT NULL AND "scope_key" = "category_id")
  );

-- A confirmed receipt must point at its transaction, and only a confirmed one may.
ALTER TABLE "receipt_drafts"
  ADD CONSTRAINT "receipt_drafts_confirmed_has_tx_chk" CHECK (
    ("status" = 'CONFIRMED') = ("transaction_id" IS NOT NULL)
  );

-- Audit trail: a short action name and a bounded metadata document (ids and kinds only; amounts and text never
-- belong here). The table has no foreign key, so an event can name a user that no longer exists.

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_user_id_created_at_idx" ON "audit_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at");

-- The trail must stay small and well-formed whatever the application does: a short action name and a
-- bounded metadata document (ids and kinds only; amounts and text never belong here).
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_action_len_chk" CHECK (char_length("action") BETWEEN 1 AND 64),
  ADD CONSTRAINT "audit_events_metadata_size_chk" CHECK ("metadata" IS NULL OR pg_column_size("metadata") <= 4096);

-- Tenant isolation, enforced by the DATABASE as well as by the application.
--
-- Every user-owned row carries user_id, and every query names the owner. What the schema cannot stop on its
-- own is a row that POINTS at another user's data: a transaction or budget naming a category that belongs
-- to someone else, or a receipt draft linked to someone else's transaction. A plain composite foreign key
-- cannot express "my category OR a shared system category" (system categories have user_id NULL), so these
-- triggers check it instead. They fire only on INSERT and on UPDATE of the columns involved, and never read
-- other users' rows beyond the single parent lookup.
-- (Prisma does not model triggers, so `prisma migrate diff` is unaffected.)
--
-- Design of the functions:
--   * every table is schema-qualified and search_path is pinned, so a role that may create TEMP tables cannot
--     shadow `categories`/`transactions` with a fake one that the trigger would then consult;
--   * the parent row is read FOR SHARE, so a concurrent change of the category's owner has to wait for the
--     writing transaction to finish instead of slipping in between the check and the commit.

CREATE OR REPLACE FUNCTION finance_bot_assert_category_owner() RETURNS trigger AS $$
BEGIN
  IF NEW.category_id IS NOT NULL THEN
    PERFORM 1 FROM public.categories c
      WHERE c.id = NEW.category_id AND (c.user_id IS NULL OR c.user_id = NEW.user_id)
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'category does not belong to the owner of this row'
        USING ERRCODE = '23514', CONSTRAINT = 'category_owner_matches';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER transactions_category_owner
  BEFORE INSERT OR UPDATE OF category_id, user_id ON transactions
  FOR EACH ROW EXECUTE FUNCTION finance_bot_assert_category_owner();

CREATE TRIGGER budgets_category_owner
  BEFORE INSERT OR UPDATE OF category_id, user_id ON budgets
  FOR EACH ROW EXECUTE FUNCTION finance_bot_assert_category_owner();

CREATE OR REPLACE FUNCTION finance_bot_assert_draft_transaction_owner() RETURNS trigger AS $$
BEGIN
  IF NEW.transaction_id IS NOT NULL THEN
    PERFORM 1 FROM public.transactions t
      WHERE t.id = NEW.transaction_id AND t.user_id = NEW.user_id
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'transaction does not belong to the owner of this receipt draft'
        USING ERRCODE = '23514', CONSTRAINT = 'draft_transaction_owner_matches';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER receipt_drafts_transaction_owner
  BEFORE INSERT OR UPDATE OF transaction_id, user_id ON receipt_drafts
  FOR EACH ROW EXECUTE FUNCTION finance_bot_assert_draft_transaction_owner();

-- A category that anything still uses cannot change owner (an unused one can). Moving a category to another
-- owner while rows of the old owner still use it (`UPDATE categories SET user_id = <someone else>`) would leave
-- transactions and budgets pointing at a category that is no longer theirs, and the row triggers on
-- transactions/budgets only fire on THEIR writes. Like the guards above, the function is schema-qualified with
-- a pinned search_path (a TEMP table must not be able to stand in for `transactions` or `budgets`).

CREATE OR REPLACE FUNCTION finance_bot_assert_category_owner_unchanged() RETURNS trigger AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id AND (
    EXISTS (SELECT 1 FROM public.transactions t WHERE t.category_id = OLD.id AND t.user_id IS DISTINCT FROM NEW.user_id)
    OR EXISTS (SELECT 1 FROM public.budgets b WHERE b.category_id = OLD.id AND b.user_id IS DISTINCT FROM NEW.user_id)
  ) THEN
    RAISE EXCEPTION 'category is still used by rows of its current owner'
      USING ERRCODE = '23514', CONSTRAINT = 'category_owner_in_use';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER categories_owner_unchanged
  BEFORE UPDATE OF user_id ON categories
  FOR EACH ROW EXECUTE FUNCTION finance_bot_assert_category_owner_unchanged();
