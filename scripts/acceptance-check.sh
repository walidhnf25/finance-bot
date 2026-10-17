#!/usr/bin/env bash
# Verifies a REAL Telegram acceptance test against the working database (read-only; the duplicate
# probe runs inside a transaction that is always rolled back).
#
#   bash scripts/acceptance-check.sh FINBOTTEST1 [FINBOTTEST2 ...]
#
# Send harmless test messages whose description contains an identifiable marker (see
# docs/testing/telegram-real-integration-checklist.md), then run this with the markers you used.
# For every marker it reports the matching transactions and checks:
#   1. exactly one live transaction exists (a retried or replayed message did not duplicate it),
#   2. the row carries an idempotency key and the database refuses a second row with the same key,
#   3. a receipt-based transaction is linked to exactly one CONFIRMED draft,
#   4. the application logs contain neither the marker text nor anything that looks like a bot token.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib-db.sh
. scripts/lib-db.sh

[ "$#" -ge 1 ] || { echo "Usage: acceptance-check.sh <marker> [marker ...]" >&2; exit 2; }
require_container_running
psql_db() { docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -At -F '|' "$@"; }

fail=0
check() { # check <ok 0|1> <message>
  if [ "$1" = "1" ]; then echo "  PASS  $2"; else echo "  FAIL  $2"; fail=$((fail + 1)); fi
}

for marker in "$@"; do
  [[ "$marker" =~ ^[A-Za-z0-9_-]{3,40}$ ]] || { echo "Marker must be 3-40 letters, digits, - or _." >&2; exit 2; }
  echo
  echo "=== marker: $marker"
  rows="$(psql_db -c "SELECT substr(id,1,8), type, amount_minor, coalesce(wallet::text,'-'), to_char(occurred_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD HH24:MI'), to_char(created_at AT TIME ZONE 'Asia/Jakarta','HH24:MI:SS'), CASE WHEN idempotency_key LIKE 'receipt:%' THEN 'receipt:<draft>' WHEN idempotency_key IS NULL THEN 'NONE' ELSE 'chat:message' END FROM transactions WHERE description ILIKE '%${marker}%' AND deleted_at IS NULL ORDER BY created_at")"
  count=0
  if [ -n "$rows" ]; then
    echo "  id      |type|amount_minor|wallet|occurred (WIB)|created|key kind"
    echo "$rows" | sed 's/^/  /'
    count="$(printf '%s\n' "$rows" | wc -l | tr -d ' ')"
  fi
  check "$([ "$count" = "1" ] && echo 1 || echo 0)" "exactly one live transaction matches (found $count)"
  [ "$count" = "0" ] && continue

  keyless="$(psql_db -c "SELECT count(*) FROM transactions WHERE description ILIKE '%${marker}%' AND deleted_at IS NULL AND idempotency_key IS NULL")"
  check "$([ "$keyless" = "0" ] && echo 1 || echo 0)" "every matching row carries an idempotency key"

  # The database must refuse a duplicate of the same (user, key). Always rolled back.
  probe="$(psql_db -v ON_ERROR_STOP=0 2>&1 <<SQL || true
BEGIN;
INSERT INTO transactions (id, user_id, type, amount_minor, description, occurred_at, idempotency_key, wallet, updated_at)
  SELECT 'probe-' || substr(id,1,8), user_id, type, amount_minor, description, occurred_at, idempotency_key, wallet, now()
  FROM transactions WHERE description ILIKE '%${marker}%' AND deleted_at IS NULL AND idempotency_key IS NOT NULL LIMIT 1;
ROLLBACK;
SQL
)"
  check "$(echo "$probe" | grep -q 'duplicate key value violates unique constraint' && echo 1 || echo 0)" "a second row with the same idempotency key is refused by PostgreSQL (probe rolled back)"
  still="$(psql_db -c "SELECT count(*) FROM transactions WHERE id LIKE 'probe-%'")"
  check "$([ "$still" = "0" ] && echo 1 || echo 0)" "the probe left nothing behind"

  linked="$(psql_db -c "SELECT count(*) FROM receipt_drafts d JOIN transactions t ON t.id = d.transaction_id WHERE t.description ILIKE '%${marker}%' AND d.status = 'CONFIRMED' AND t.idempotency_key = 'receipt:' || d.id")"
  isreceipt="$(psql_db -c "SELECT count(*) FROM transactions WHERE description ILIKE '%${marker}%' AND deleted_at IS NULL AND idempotency_key LIKE 'receipt:%'")"
  if [ "$isreceipt" != "0" ]; then
    check "$([ "$linked" = "$isreceipt" ] && echo 1 || echo 0)" "the receipt transaction is linked to exactly one CONFIRMED draft ($linked of $isreceipt)"
  fi
done

echo
echo "=== recent receipt drafts (status only)"
psql_db -c "SELECT to_char(created_at AT TIME ZONE 'Asia/Jakarta','MM-DD HH24:MI:SS'), status, CASE WHEN transaction_id IS NULL THEN 'no transaction' ELSE 'has transaction' END FROM receipt_drafts ORDER BY created_at DESC LIMIT 6" | sed 's/^/  /'

echo
echo "=== logs: no message text, no token"
leaks=0
shopt -s nullglob
for f in logs/*.log; do
  for marker in "$@"; do
    if grep -q -F "$marker" "$f"; then echo "  FAIL  marker '$marker' appears in $f"; leaks=$((leaks + 1)); fi
  done
  if grep -q -E '[0-9]{8,10}:[A-Za-z0-9_-]{30,}' "$f"; then echo "  FAIL  something shaped like a bot token appears in $f"; leaks=$((leaks + 1)); fi
done
check "$([ "$leaks" = "0" ] && echo 1 || echo 0)" "logs contain neither the test text nor a token ($(ls logs/*.log 2>/dev/null | wc -l | tr -d ' ') files scanned)"

echo
if [ "$fail" -eq 0 ]; then echo "RESULT: all acceptance checks passed."; else echo "RESULT: $fail check(s) FAILED." >&2; exit 1; fi
