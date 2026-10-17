#!/usr/bin/env bash
# Restore a dump into a NEW database inside the running container. It never overwrites or drops
# an existing database: swap over deliberately afterwards (see docs/runbook.md).
#   bash scripts/restore-db.sh backups/db/finance-bot-XXXX.dump finance_bot_restored
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib-db.sh
. scripts/lib-db.sh

dump="${1:-}"
target="${2:-}"
[ -f "$dump" ] && [ -n "$target" ] || { echo "Usage: restore-db.sh <dump> <new-database-name>" >&2; exit 2; }
[[ "$target" =~ ^[a-z][a-z0-9_]{0,40}$ ]] || { echo "Database name: lowercase letters, digits, underscores." >&2; exit 2; }
[ "$target" != "$DB_NAME" ] || { echo "Refusing to restore over the working database '$DB_NAME'." >&2; exit 2; }
require_container_running
if is_encrypted_file "$dump"; then
  have_gpg || { echo "gpg was not found; it is needed to read $dump." >&2; exit 1; }
  prepare_passphrase 0
fi

exists="$(docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -At -c "SELECT 1 FROM pg_database WHERE datname='${target}'")"
[ -z "$exists" ] || { echo "Database '$target' already exists; choose a new name." >&2; exit 2; }

docker exec "$CONTAINER" createdb -U "$DB_USER" "$target"
dump_stream "$dump" | docker exec -i "$CONTAINER" pg_restore -U "$DB_USER" -d "$target" --no-owner --no-privileges --exit-on-error
echo "Restored into database '$target'. Check it, then point DATABASE_URL at it when ready."
