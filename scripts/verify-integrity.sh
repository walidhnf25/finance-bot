#!/usr/bin/env bash
# Data integrity audit of the finance bot database (read-only): foreign keys, duplicates, orphans,
# receipt-to-transaction links, plus exact money totals.
#   npm run db:verify                  the working database
#   bash scripts/verify-integrity.sh finance_bot_restored   another database in the same container
# Exit code 0 only when every check ran and reports 0 violations (1 = violations found, 3 = the checks could not run).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib-db.sh
. scripts/lib-db.sh

target="${1:-$DB_NAME}"
require_container_running

echo "Integrity checks on database '$target' (every line must end with |0):"
violations=0
rows="$(integrity_rows "$CONTAINER" "$DB_USER" "$target")" || exit 3
while IFS='|' read -r name count; do
  [ -z "$name" ] && continue
  if [ "$count" = "0" ]; then status="ok  "; else status="FAIL"; violations=$((violations + 1)); fi
  printf '  %s %s (%s)\n' "$status" "$name" "$count"
done <<<"$rows"

echo
echo "Exact totals (minor units = rupiah x 100):"
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$target" -At <scripts/sql/totals.sql | sed 's/^/  /'

echo
if [ "$violations" -eq 0 ]; then
  echo "RESULT: all integrity checks passed."
else
  echo "RESULT: $violations check(s) FAILED. Investigate before relying on this database." >&2
  exit 1
fi
