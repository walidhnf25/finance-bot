#!/usr/bin/env bash
# Proves a backup can actually be restored, WITHOUT touching the working database or any other
# project's containers: it starts a throwaway Postgres container (no published port), restores the
# dump into it, compares row counts / money totals with the live database, and always removes the
# container again.
#   npm run db:restore-rehearsal                       latest backup in backups/db (.dump.gpg or .dump)
#   bash scripts/restore-rehearsal.sh backups/db/x.dump.gpg
# Encrypted backups are decrypted in memory straight into pg_restore: no plaintext file is written.
# Needs the passphrase (FINANCE_BOT_BACKUP_PASSPHRASE_FILE, or a prompt in a terminal).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib-db.sh
. scripts/lib-db.sh

dump="${1:-$(ls -1t backups/db/finance-bot-*.dump.gpg backups/db/finance-bot-*.dump 2>/dev/null | head -n1 || true)}"
[ -n "$dump" ] && [ -f "$dump" ] || { echo "No dump found. Run: npm run db:backup" >&2; exit 1; }

# Integrity first: the recorded checksum must match.
if [ -f "${dump}.sha256" ]; then
  expected="$(cut -d' ' -f1 "${dump}.sha256")"
  [ "$(sha256_of "$dump")" = "$expected" ] || { echo "Checksum mismatch for $dump" >&2; exit 1; }
  echo "checksum ok"
fi

if is_encrypted_file "$dump"; then
  have_gpg || { echo "gpg was not found; it is needed to read $dump." >&2; exit 1; }
  prepare_passphrase 0
fi

name="finance-bot-restore-rehearsal-$$"
password="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
cleanup() { docker rm -fv "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" --label finance-bot.rehearsal=true \
  -e POSTGRES_PASSWORD="$password" -e POSTGRES_USER=rehearsal -e POSTGRES_DB=rehearsal \
  --tmpfs /var/lib/postgresql/data:rw,uid=70,gid=70,mode=700,size=2g \
  postgres:16-alpine >/dev/null

# The official image restarts once during its own initialisation, so wait for a stable answer.
ready=0
for _ in $(seq 1 60); do
  if docker exec "$name" psql -U rehearsal -d rehearsal -At -c "SELECT 1" >/dev/null 2>&1; then
    sleep 2
    docker exec "$name" psql -U rehearsal -d rehearsal -At -c "SELECT 1" >/dev/null 2>&1 && ready=1 && break
  fi
  sleep 1
done
[ "$ready" = "1" ] || { echo "Rehearsal database did not start" >&2; exit 1; }

dump_stream "$dump" | docker exec -i "$name" pg_restore -U rehearsal -d rehearsal --no-owner --no-privileges --exit-on-error

# The restored copy must also pass the integrity audit (orphans, duplicates, receipt links ...).
bad=0
rows="$(integrity_rows "$name" rehearsal rehearsal)" || { echo "Could not run the integrity checks on the restored copy." >&2; exit 4; }
while IFS='|' read -r check count; do
  [ -z "$check" ] && continue
  if [ "$count" != "0" ]; then bad=$((bad + 1)); echo "integrity FAIL in the copy: $check ($count)" >&2; fi
done <<<"$rows"
[ "$bad" -eq 0 ] || { echo "The restored copy failed $bad integrity check(s)." >&2; exit 4; }
echo "integrity checks on the restored copy: all passed"

restored="$(fingerprint_sql | docker exec -i "$name" psql -U rehearsal -d rehearsal -At)"
live=""
if [ "${REHEARSAL_COMPARE_LIVE:-1}" = "1" ] && [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ]; then
  live="$(fingerprint_sql | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -At)"
fi

echo "--- restored copy ---"
echo "$restored"
migrations="$(docker exec "$name" psql -U rehearsal -d rehearsal -At -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")"
echo "migrations applied in copy: $migrations"

if [ -n "$live" ]; then
  if [ "$live" = "$restored" ]; then
    echo "RESULT: restored copy MATCHES the live database (row counts and money totals)."
  else
    echo "RESULT: the copy differs from the live database (expected only if data changed after the backup)." >&2
    echo "--- live database ---" >&2
    echo "$live" >&2
    exit 3
  fi
else
  echo "RESULT: restore succeeded (live database not compared)."
fi
