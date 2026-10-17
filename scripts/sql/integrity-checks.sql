-- Finance bot data integrity checks. Every row is "<check name>|<number of violations>"; the correct
-- answer for all of them is 0. Read-only. Run with: npm run db:verify
-- Many of these are also enforced by constraints (foreign keys, UNIQUE, CHECK); they are
-- repeated here so a restored copy, an imported database or a hand-edited one can be audited.

SELECT 'orphan transactions (user missing)|' || count(*)
  FROM transactions t LEFT JOIN users u ON u.id = t.user_id WHERE u.id IS NULL
UNION ALL SELECT 'transactions pointing at a missing category|' || count(*)
  FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
  WHERE t.category_id IS NOT NULL AND c.id IS NULL
UNION ALL SELECT 'transactions with a non-positive or over-limit amount|' || count(*)
  FROM transactions WHERE amount_minor <= 0 OR amount_minor > 1000000000000000
UNION ALL SELECT 'duplicate transaction idempotency keys per user|' || count(*)
  FROM (SELECT user_id, idempotency_key FROM transactions WHERE idempotency_key IS NOT NULL
        GROUP BY 1, 2 HAVING count(*) > 1) d
UNION ALL SELECT 'orphan transfers (user missing)|' || count(*)
  FROM transfers t LEFT JOIN users u ON u.id = t.user_id WHERE u.id IS NULL
UNION ALL SELECT 'transfers between the same wallet or with a bad amount|' || count(*)
  FROM transfers WHERE from_wallet = to_wallet OR amount_minor <= 0 OR amount_minor > 1000000000000000
UNION ALL SELECT 'duplicate transfer idempotency keys per user|' || count(*)
  FROM (SELECT user_id, idempotency_key FROM transfers WHERE idempotency_key IS NOT NULL
        GROUP BY 1, 2 HAVING count(*) > 1) d
UNION ALL SELECT 'orphan budgets (user or category missing)|' || count(*)
  FROM budgets b LEFT JOIN users u ON u.id = b.user_id LEFT JOIN categories c ON c.id = b.category_id
  WHERE u.id IS NULL OR (b.category_id IS NOT NULL AND c.id IS NULL)
UNION ALL SELECT 'duplicate budgets for the same (user, scope, period)|' || count(*)
  FROM (SELECT user_id, scope_key, period FROM budgets GROUP BY 1, 2, 3 HAVING count(*) > 1) d
UNION ALL SELECT 'categories owned by a missing user|' || count(*)
  FROM categories c LEFT JOIN users u ON u.id = c.user_id WHERE c.user_id IS NOT NULL AND u.id IS NULL
UNION ALL SELECT 'duplicate category (user, name, type)|' || count(*)
  FROM (SELECT user_id, name, type FROM categories WHERE user_id IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1) d
UNION ALL SELECT 'more than one live opening-balance entry per user and wallet|' || count(*)
  FROM (SELECT user_id, coalesce(wallet::text, 'CASH') AS w FROM transactions
        WHERE note = 'SALDO_AWAL' AND deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1) d
UNION ALL SELECT 'receipt drafts of a missing user|' || count(*)
  FROM receipt_drafts r LEFT JOIN users u ON u.id = r.user_id WHERE u.id IS NULL
UNION ALL SELECT 'confirmed receipt drafts without an existing transaction of the same user|' || count(*)
  FROM receipt_drafts r LEFT JOIN transactions t ON t.id = r.transaction_id AND t.user_id = r.user_id
  WHERE r.status = 'CONFIRMED' AND t.id IS NULL
UNION ALL SELECT 'receipt transactions whose idempotency key does not match their draft|' || count(*)
  FROM receipt_drafts r JOIN transactions t ON t.id = r.transaction_id
  WHERE t.idempotency_key IS DISTINCT FROM 'receipt:' || r.id
UNION ALL SELECT 'non-confirmed receipt drafts that already carry a transaction|' || count(*)
  FROM receipt_drafts WHERE status <> 'CONFIRMED' AND transaction_id IS NOT NULL
UNION ALL SELECT 'conversations of a missing user|' || count(*)
  FROM conversations c LEFT JOIN users u ON u.id = c.user_id WHERE u.id IS NULL
UNION ALL SELECT 'users without a telegram id|' || count(*)
  FROM users WHERE telegram_id IS NULL OR telegram_id = ''
UNION ALL SELECT 'transactions or budgets that use another user''s category|' || (
  (SELECT count(*) FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE c.user_id IS NOT NULL AND c.user_id <> t.user_id)
  + (SELECT count(*) FROM budgets b JOIN categories c ON c.id = b.category_id
    WHERE c.user_id IS NOT NULL AND c.user_id <> b.user_id))
UNION ALL SELECT 'receipt drafts linked to another user''s transaction|' || count(*)
  FROM receipt_drafts r JOIN transactions t ON t.id = r.transaction_id WHERE t.user_id <> r.user_id;
