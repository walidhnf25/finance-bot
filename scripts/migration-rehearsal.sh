#!/usr/bin/env bash
# Rehearses the PENDING database migrations on a throw-away COPY of the working database, so you can see what
# `npm run prisma:deploy` will do before it touches your data.
#   npm run db:migrate-rehearsal
#
# What it does (the working database is only READ):
#   1. streams a pg_dump of the working database straight into a throw-away container (no dump file; the copy
#      lives only in that container's RAM-backed tmpfs, so no plaintext copy of your finances is left on disk,
#      and the container is removed together with any volume);
#   2. fingerprints the copy (row counts and exact money totals);
#   3. runs `prisma migrate deploy` on the COPY, which applies exactly the pending migrations;
#   4. checks that the copy matched the working database to begin with, that the fingerprint (row counts and
#      exact money totals) is unchanged by the migrations,
#      that `prisma migrate status` is clean, and that every integrity check still passes;
#   5. removes the container.
# Exit 0 only when all of that holds. It never runs a migration on the working database.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib-db.sh
. scripts/lib-db.sh

require_container_running
name="finance-bot-migrate-rehearsal-$$"
password="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
cleanup() { docker rm -fv "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Pending migrations on the working database:"
# `migrate status` exits non-zero when migrations are pending, so judge by its OUTPUT, and refuse to guess:
status_out="$(npx prisma migrate status 2>&1 || true)"
if printf '%s' "$status_out" | grep -q "Database schema is up to date"; then
  echo "  (none: nothing to rehearse)"; exit 0
fi
if ! printf '%s' "$status_out" | grep -q "have not yet been applied"; then
  echo "Could not read the migration status of the working database; refusing to rehearse blindly:" >&2
  printf '%s\n' "$status_out" | tail -n 8 >&2
  exit 2
fi
pending="$(printf '%s' "$status_out" | sed -n '/have not yet been applied/,/^To apply/p' | grep -E '^[0-9]{14}_' || true)"
printf '  %s\n' $pending

docker run -d --name "$name" --label finance-bot.rehearsal=true \
  -e POSTGRES_PASSWORD="$password" -e POSTGRES_USER="$DB_USER" -e POSTGRES_DB="$DB_NAME" \
  --tmpfs /var/lib/postgresql/data:rw,uid=70,gid=70,mode=700,size=2g \
  -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$name" psql -U "$DB_USER" -d "$DB_NAME" -At -c "SELECT 1" >/dev/null 2>&1; then
    sleep 2
    docker exec "$name" psql -U "$DB_USER" -d "$DB_NAME" -At -c "SELECT 1" >/dev/null 2>&1 && ready=1 && break
  fi
  sleep 1
done
[ "$ready" = "1" ] || { echo "The rehearsal database did not start." >&2; exit 1; }
port="$(docker port "$name" 5432/tcp | head -n1 | sed 's/.*://')"
url="postgresql://${DB_USER}:${password}@127.0.0.1:${port}/${DB_NAME}?schema=public"

echo "Copying the working database into the throw-away container (read-only on the source)..."
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --no-owner --no-privileges \
  | docker exec -i "$name" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges --exit-on-error

source_fp="$(fingerprint_sql | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -At)"
before="$(fingerprint_sql | docker exec -i "$name" psql -U "$DB_USER" -d "$DB_NAME" -At)"
echo "Applying the pending migrations to the COPY..."
DATABASE_URL="$url" npx prisma migrate deploy 2>&1 | grep -E "Applying migration|have been successfully|Error|error" || true
after="$(fingerprint_sql | docker exec -i "$name" psql -U "$DB_USER" -d "$DB_NAME" -At)"

status=0
if [ "$source_fp" = "$before" ]; then
  echo "OK    the copy matches the working database (row counts and money totals)."
else
  echo "FAIL  the copy does not match the working database (data changed while copying?); the rehearsal proves nothing." >&2
  status=1
fi
if [ "$before" = "$after" ]; then
  echo "OK    row counts and money totals are identical before and after the migrations."
else
  echo "FAIL  the migrations changed the data:" >&2
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
  status=1
fi
if DATABASE_URL="$url" npx prisma migrate status 2>&1 | grep -q "Database schema is up to date"; then
  echo "OK    the copy reports 'Database schema is up to date'."
else
  echo "FAIL  the copy still reports pending or failed migrations." >&2
  status=1
fi
if rows="$(integrity_rows "$name" "$DB_USER" "$DB_NAME")"; then
  bad=0
  while IFS='|' read -r check count; do
    [ -z "$check" ] && continue
    [ "$count" = "0" ] || { bad=$((bad + 1)); echo "FAIL  integrity: $check ($count)" >&2; }
  done <<<"$rows"
  if [ "$bad" -eq 0 ]; then echo "OK    all integrity checks pass on the migrated copy."; else status=1; fi
else
  status=1
fi

echo
if [ "$status" -eq 0 ]; then
  echo "RESULT: the pending migrations apply cleanly to a copy of your data and leave its row counts and money totals unchanged."
  echo "Next, on the working database (after a backup):  npm run db:backup  &&  npm run prisma:deploy"
else
  echo "RESULT: the rehearsal FAILED. Do not run prisma:deploy on the working database." >&2
fi
exit "$status"
