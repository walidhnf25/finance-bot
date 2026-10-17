-- Exact totals (BIGINT minor units = rupiah x 100) used to compare a source, a restored copy and the
-- live database. Deterministic text, one line per figure. Read-only.
SELECT 'users|' || count(*) FROM users
UNION ALL SELECT 'categories|' || count(*) FROM categories
UNION ALL SELECT 'transactions|' || count(*) || '|live=' || count(*) FILTER (WHERE deleted_at IS NULL)
                 || '|income_minor=' || coalesce(sum(amount_minor) FILTER (WHERE type = 'INCOME' AND deleted_at IS NULL), 0)
                 || '|expense_minor=' || coalesce(sum(amount_minor) FILTER (WHERE type = 'EXPENSE' AND deleted_at IS NULL), 0)
  FROM transactions
UNION ALL SELECT 'transfers|' || count(*) || '|sum_minor=' || coalesce(sum(amount_minor), 0) FROM transfers WHERE deleted_at IS NULL
UNION ALL SELECT 'budgets|' || count(*) || '|sum_minor=' || coalesce(sum(amount_minor), 0) FROM budgets
UNION ALL SELECT 'receipt_drafts|' || count(*) || '|confirmed=' || count(*) FILTER (WHERE status = 'CONFIRMED') FROM receipt_drafts
UNION ALL SELECT 'balance_' || w || '|' || coalesce(
    (SELECT sum(CASE WHEN type = 'INCOME' THEN amount_minor ELSE -amount_minor END)
       FROM transactions WHERE deleted_at IS NULL AND coalesce(wallet::text, 'CASH') = w), 0)
    + coalesce((SELECT sum(amount_minor) FROM transfers WHERE deleted_at IS NULL AND to_wallet::text = w), 0)
    - coalesce((SELECT sum(amount_minor) FROM transfers WHERE deleted_at IS NULL AND from_wallet::text = w), 0)
  FROM (VALUES ('CASH'), ('DIGITAL')) AS wallets(w)
ORDER BY 1;
